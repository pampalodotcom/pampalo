"use node";

import { v } from "convex/values";
import { HDNodeWallet, Interface } from "ethers";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { alchemyUrl, rpc } from "../lib/alchemy";
import type { BlockMatch } from "./store";

// Automated compliance scan + contest (ADR 0016). Walks the still-queued
// shields, screens each shielder against the blocklist table (OFAC/manual)
// and the live Chainalysis sanctions oracle, and calls contestShield() on
// matches BEFORE the shield wait elapses — refunding the shielder's escrow
// and keeping the address out of the pool. Permissionless `shield(...)`
// means this post-hoc contest is the only enforcement point (ADR 0007).
//
// Signed by the dedicated compliance signer (index 5 off RELAYER_MNEMONIC,
// VIGILANT_CITIZEN_ROLE) — NEVER the role-less relayer pool (ADR 0016).

// The compliance signer sits one index past the 5-account relayer pool.
const COMPLIANCE_INDEX = 5;
const CONTEST_GAS_LIMIT = 300_000n;

// Chainalysis on-chain sanctions oracle, per chain. isSanctioned(address)
// is a per-address lookup (not enumerable), so it's queried live here
// rather than ingested into blockedAddresses. Only verified addresses
// belong here — an unset chain simply skips the oracle and relies on the
// ingested blocklist. Base Sepolia (84532) has no oracle; mainnet entries
// are added (and verified) when a mainnet deployment goes live.
const SANCTIONS_ORACLE: Record<number, string> = {
  1: "0x40c57923924b5c5c5455c48d93317139addac8fb", // Ethereum mainnet
};

const ORACLE_IFACE = new Interface([
  "function isSanctioned(address) view returns (bool)",
]);
const PAMPALO_IFACE = new Interface([
  "function contestShield(uint256 id, string reason)",
]);

function complianceWallet(): HDNodeWallet {
  const mnemonic = process.env.RELAYER_MNEMONIC;
  if (!mnemonic) throw new Error("RELAYER_MNEMONIC not set in Convex env");
  return HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    `m/44'/60'/0'/0/${COMPLIANCE_INDEX}`,
  );
}

// Live Chainalysis check. Returns a match when the oracle says sanctioned;
// silently returns null when no oracle is configured or the call can't be
// evaluated (absent oracle contract returns "0x").
async function oracleMatch(
  chainId: number,
  url: string,
  address: string,
): Promise<BlockMatch | null> {
  const oracle = SANCTIONS_ORACLE[chainId];
  if (!oracle) return null;
  try {
    const data = ORACLE_IFACE.encodeFunctionData("isSanctioned", [address]);
    const res = await rpc<string>(url, "eth_call", [
      { to: oracle, data },
      "latest",
    ]);
    if (!res || res === "0x") return null;
    if (BigInt(res) !== 0n) {
      return { source: "chainalysis", reason: "Chainalysis on-chain sanctions" };
    }
  } catch {
    // Oracle unreachable / not a contract — treat as no-match, don't block.
  }
  return null;
}

function contestReason(matches: BlockMatch[]): string {
  const sources = [...new Set(matches.map((m) => m.source))].join("+");
  const detail = matches[0]?.reason ?? "compliance match";
  return `${sources}: ${detail}`.slice(0, 200);
}

export const scanAndContest = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    screened: number;
    flagged: number;
    contested: number;
    wouldContest: number;
  }> => {
    // Safety valve: contests only broadcast when explicitly enabled. Until
    // then the cron runs in detect-and-log mode so an operator can vet the
    // matches before letting it cancel shields autonomously.
    const autoContest = process.env.COMPLIANCE_AUTO_CONTEST === "1";

    const entries = await ctx.runQuery(
      internal.compliance.store._queuedToScreen,
      {},
    );
    if (entries.length === 0)
      return { screened: 0, flagged: 0, contested: 0, wouldContest: 0 };

    let wallet: HDNodeWallet | null = null;
    const signer = (): HDNodeWallet => (wallet ??= complianceWallet());
    const nonces = new Map<number, number>();

    let flagged = 0;
    let contested = 0;
    let wouldContest = 0;

    for (const e of entries) {
      const url = alchemyUrl(e.alchemySubdomain);

      // Screen: blocklist table (any source) + live oracle.
      const tableMatches: BlockMatch[] = await ctx.runQuery(
        internal.compliance.store._blockedFor,
        { address: e.shielder },
      );
      const oracle = await oracleMatch(e.chainId, url, e.shielder);
      const matches = oracle ? [...tableMatches, oracle] : tableMatches;
      if (matches.length === 0) continue;
      flagged += 1;

      const reason = contestReason(matches);
      const data = PAMPALO_IFACE.encodeFunctionData("contestShield", [
        BigInt(e.pendingId),
        reason,
      ]);

      // Simulate before spending gas — catches already-cancelled/executed
      // shields and a missing role grant, so we don't spam reverts.
      try {
        await rpc<string>(url, "eth_call", [
          { from: signer().address, to: e.pampalo, data, value: "0x0" },
          "latest",
        ]);
      } catch (simErr) {
        console.warn(
          `[compliance] skip pendingId ${e.pendingId} on chain ${e.chainId}: ` +
            `sim revert (${simErr instanceof Error ? simErr.message : simErr})`,
        );
        continue;
      }

      if (!autoContest) {
        wouldContest += 1;
        console.warn(
          `[compliance] WOULD contest pendingId ${e.pendingId} ` +
            `(shielder ${e.shielder}, chain ${e.chainId}) — ${reason}. ` +
            `Set COMPLIANCE_AUTO_CONTEST=1 to enable.`,
        );
        continue;
      }

      // Broadcast the contest. Sequential nonce per chain off the single
      // compliance signer.
      try {
        let nonce = nonces.get(e.chainId);
        if (nonce === undefined) {
          const nh = await rpc<string>(url, "eth_getTransactionCount", [
            signer().address,
            "pending",
          ]);
          nonce = Number(BigInt(nh));
        }
        const block = await rpc<{ baseFeePerGas?: string }>(
          url,
          "eth_getBlockByNumber",
          ["latest", false],
        );
        const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
        const maxPriorityFeePerGas = 1_000_000_000n;
        const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
        const signed = await signer().signTransaction({
          to: e.pampalo,
          data,
          value: 0n,
          nonce,
          gasLimit: CONTEST_GAS_LIMIT,
          maxFeePerGas,
          maxPriorityFeePerGas,
          chainId: e.chainId,
          type: 2,
        });
        const txHash = await rpc<string>(url, "eth_sendRawTransaction", [signed]);
        nonces.set(e.chainId, nonce + 1);
        contested += 1;
        await ctx.runMutation(internal.compliance.store.recordContest, {
          chainId: e.chainId,
          txHash,
        });
        console.warn(
          `[compliance] contested pendingId ${e.pendingId} on chain ${e.chainId} ` +
            `tx ${txHash} — ${reason}`,
        );
      } catch (txErr) {
        console.warn(
          `[compliance] contest broadcast failed for pendingId ${e.pendingId}: ` +
            `${txErr instanceof Error ? txErr.message : txErr}`,
        );
      }
    }

    return {
      screened: entries.length,
      flagged,
      contested,
      wouldContest,
    };
  },
});

/** Print the compliance signer's address so an operator can fund it +
 *  grant VIGILANT_CITIZEN_ROLE. Address is chain-independent. Run with:
 *    pnpm convex run compliance/node:complianceSignerInfo
 */
export const complianceSignerInfo = internalAction({
  args: {},
  handler: async (): Promise<{ index: number; address: string }> => {
    return { index: COMPLIANCE_INDEX, address: complianceWallet().address };
  },
});

/** Seed the compliance-signer row for a chain so the /sentry panel can show
 *  it (address + live balance). Idempotent. Run with:
 *    pnpm convex run compliance/node:seedComplianceSigner '{"chainId":84532}'
 */
export const seedComplianceSigner = internalAction({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ chainId: number; address: string }> => {
    const dep = await ctx.runQuery(
      internal.relayer.store._relayerDeploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep) throw new Error(`no enabled deployment for chain ${args.chainId}`);
    const address = complianceWallet().address.toLowerCase();
    const balHex = await rpc<string>(alchemyUrl(dep.alchemySubdomain), "eth_getBalance", [
      address,
      "latest",
    ]);
    await ctx.runMutation(internal.compliance.store.upsertComplianceSigner, {
      chainId: args.chainId,
      address,
      balanceWei: BigInt(balHex).toString(),
    });
    return { chainId: args.chainId, address };
  },
});

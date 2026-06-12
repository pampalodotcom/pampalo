"use node";

import { HDNodeWallet, Interface } from "ethers";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { alchemyUrl, rpc } from "../lib/alchemy";
import type { RelayerDeployment } from "./store";

// Signing + broadcasting half of the gas-sponsoring relayer (TRANSFERS.md
// §3, ADR 0015). Node runtime because it derives HD wallets and signs
// transactions with ethers. The DB-side mutex + accounting lives in
// relayer/store.ts (fast runtime); this action orchestrates them.
//
// RELAYER_MNEMONIC is read here ONLY, derived for the one acquired index,
// used to sign one tx, and dropped when the handler returns. It is never
// read in any client-facing surface. See TRANSFERS.md §4.

// Pool = indices 0..4. Index 5 is the compliance signer (ADR 0016) and is
// NOT broadcast from here.
const RELAYER_POOL_SIZE = 5;

// Upper-bound gas the relayer is willing to sponsor per call. The
// UltraHonk verifier is heavy; the client self-broadcast path uses 8M for
// both, so we match it (eth_call sim catches anything that truly reverts).
const GAS_LIMIT: Record<RelayKind, bigint> = {
  transfer: 8_000_000n,
  unshield: 8_000_000n,
};

// Minimal human-readable ABI for the two relayed entrypoints. Note the
// withdraw path is `unshieldBundled` (transfer_external circuit) — the
// same function the client's UnshieldConfirmSheet encodes — which carries
// the change-output ECIES payload, not the bare `unshield`.
const PAMPALO_IFACE = new Interface([
  "function transfer(bytes proof, bytes32[] publicInputs, bytes[] payload)",
  "function unshieldBundled(bytes proof, bytes32[] publicInputs, bytes[] payload)",
]);

type RelayKind = "transfer" | "unshield";

export type RelayResult =
  | { ok: true; chainId: number; txHash: string }
  | { ok: false; reason: "WOULD_REVERT"; revertReason: string }
  | { ok: false; reason: "POOL_EXHAUSTED" }
  | { ok: false; reason: "CHAIN_NOT_SPONSORED" }
  | { ok: false; reason: "BAD_PROOF" }
  | { ok: false; reason: "UNKNOWN"; message: string };

/** Derive the lowercased EVM address for a relayer/compliance index. Pure
 *  public material — exported so the seed action can populate rows. */
export function deriveRelayerWallet(index: number): HDNodeWallet {
  const mnemonic = process.env.RELAYER_MNEMONIC;
  if (!mnemonic) throw new Error("RELAYER_MNEMONIC not set in Convex env");
  return HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
}

// A hex string is "non-zero" if it has bytes and at least one is non-zero.
function isNonZeroHex(s: string): boolean {
  if (typeof s !== "string" || !/^0x[0-9a-fA-F]*$/.test(s)) return false;
  const body = s.slice(2);
  return body.length > 0 && /[1-9a-fA-F]/.test(body);
}

function parseRevertReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /execution reverted:?\s*(.*)$/i.exec(msg);
  return (m?.[1] || msg).trim().slice(0, 200);
}

export const relay = action({
  args: {
    sessionToken: v.string(),
    chainId: v.number(),
    kind: v.union(v.literal("transfer"), v.literal("unshield")),
    proof: v.string(),
    publicInputs: v.array(v.string()),
    // Required for transfer (ECIES NotePayload ciphertexts, 0..3); ignored
    // for unshield, which emits no payload.
    payload: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<RelayResult> => {
    // 1. Auth gate (rate-limit only; no userId→tx row is written).
    const userId = await ctx.runQuery(
      internal.relayer.store._userIdForSession,
      { sessionToken: args.sessionToken },
    );
    if (!userId) throw new Error("invalid or expired session");

    // 2. Cheap non-zero proof gate before any RPC work.
    if (
      !isNonZeroHex(args.proof) ||
      args.publicInputs.length === 0 ||
      !args.publicInputs.some(isNonZeroHex)
    ) {
      return { ok: false, reason: "BAD_PROOF" };
    }

    // 3. Deployment + sponsoring check.
    const dep: RelayerDeployment | null = await ctx.runQuery(
      internal.relayer.store._relayerDeploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep || dep.pampalo === "") {
      return { ok: false, reason: "CHAIN_NOT_SPONSORED" };
    }
    if (!dep.sponsoringTxs) {
      return { ok: false, reason: "CHAIN_NOT_SPONSORED" };
    }

    // 4. Acquire an idle, funded account (atomic).
    const lock = await ctx.runMutation(
      internal.relayer.store.acquireRelayerLock,
      { chainId: args.chainId, minRelayerBalanceWei: dep.minRelayerBalanceWei },
    );
    if (!lock) return { ok: false, reason: "POOL_EXHAUSTED" };

    const url = alchemyUrl(dep.alchemySubdomain);
    const kind: RelayKind = args.kind;

    try {
      // 5. Sanity: derived address must match the cached row address.
      const wallet = deriveRelayerWallet(lock.accountIndex);
      if (wallet.address.toLowerCase() !== lock.address.toLowerCase()) {
        await ctx.runMutation(internal.relayer.store.releaseLockNoCharge, {
          chainId: args.chainId,
          accountIndex: lock.accountIndex,
        });
        return {
          ok: false,
          reason: "UNKNOWN",
          message: "relayer address mismatch (mnemonic/seed drift)",
        };
      }

      // 6. Encode calldata for the requested entrypoint. Both entrypoints
      //    carry the (proof, publicInputs, payload) shape; only the
      //    function selector differs.
      const fn = kind === "transfer" ? "transfer" : "unshieldBundled";
      const data = PAMPALO_IFACE.encodeFunctionData(fn, [
        args.proof,
        args.publicInputs,
        args.payload ?? [],
      ]);

      // 7. Pre-broadcast simulation — never spend gas on a tx that reverts.
      try {
        await rpc<string>(url, "eth_call", [
          { from: lock.address, to: dep.pampalo, data, value: "0x0" },
          "latest",
        ]);
      } catch (simErr) {
        await ctx.runMutation(internal.relayer.store.releaseLockNoCharge, {
          chainId: args.chainId,
          accountIndex: lock.accountIndex,
        });
        return {
          ok: false,
          reason: "WOULD_REVERT",
          revertReason: parseRevertReason(simErr),
        };
      }

      // 8. Nonce + EIP-1559 fees.
      const nonceHex = await rpc<string>(url, "eth_getTransactionCount", [
        lock.address,
        "pending",
      ]);
      const block = await rpc<{ baseFeePerGas?: string }>(
        url,
        "eth_getBlockByNumber",
        ["latest", false],
      );
      const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
      const maxPriorityFeePerGas = 1_000_000_000n; // 1 gwei
      const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
      const gasLimit = GAS_LIMIT[kind];

      // 9. Sign (no `from`; ethers derives it from the key).
      const signed = await wallet.signTransaction({
        to: dep.pampalo,
        data,
        value: 0n,
        nonce: Number(BigInt(nonceHex)),
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chainId: args.chainId,
        type: 2,
      });

      // 10. Broadcast.
      const txHash = await rpc<string>(url, "eth_sendRawTransaction", [signed]);

      // 11. Release + optimistic balance deduction (upper-bound cost).
      const estCostWei = (gasLimit * maxFeePerGas).toString();
      await ctx.runMutation(internal.relayer.store.releaseRelayerLock, {
        chainId: args.chainId,
        accountIndex: lock.accountIndex,
        txHash,
        estCostWei,
      });

      return { ok: true, chainId: args.chainId, txHash };
    } catch (err) {
      // Any failure after acquire but before a successful broadcast:
      // release without charging so the account returns to rotation.
      await ctx.runMutation(internal.relayer.store.releaseLockNoCharge, {
        chainId: args.chainId,
        accountIndex: lock.accountIndex,
      });
      return {
        ok: false,
        reason: "UNKNOWN",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

/** Dashboard-run seed: derive the 5 pool accounts for a sponsoring chain,
 *  read each on-chain balance, and upsert the rows. Idempotent. Run with:
 *    pnpm convex run relayer/node:seedRelayerAccounts '{"chainId":84532}'
 */
export const seedRelayerAccounts = internalAction({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ chainId: number; seeded: number }> => {
    const dep: RelayerDeployment | null = await ctx.runQuery(
      internal.relayer.store._relayerDeploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep) throw new Error(`no enabled deployment for chain ${args.chainId}`);
    const url = alchemyUrl(dep.alchemySubdomain);

    let seeded = 0;
    for (let idx = 0; idx < RELAYER_POOL_SIZE; idx++) {
      const address = deriveRelayerWallet(idx).address.toLowerCase();
      const balHex = await rpc<string>(url, "eth_getBalance", [
        address,
        "latest",
      ]);
      await ctx.runMutation(internal.relayer.store.upsertRelayerAccount, {
        chainId: args.chainId,
        accountIndex: idx,
        address,
        balanceWei: BigInt(balHex).toString(),
      });
      seeded += 1;
    }
    return { chainId: args.chainId, seeded };
  },
});

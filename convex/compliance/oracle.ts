import { v } from "convex/values";
import { AbiCoder, id } from "ethers";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { alchemyUrl, rpc } from "../lib/alchemy";

// Automated blocklist ingest (ADR 0016). Two sources, both writing into the
// chain-agnostic `blockedAddresses` table the scan screens against:
//
//   1. Chainalysis sanctions oracle — indexed from its DEPLOY BLOCK forward
//      via SanctionedAddressesAdded/Removed events, so we hold every address
//      it has ever flagged ("day 1"). The oracle's isSanctioned() is a
//      per-address lookup and NOT enumerable, so events are the only way to
//      reconstruct the full set. Indexed on Ethereum mainnet (where the
//      oracle lives); a sanctioned address is sanctioned on every chain, so
//      the resulting list applies to shielders on Base Sepolia too.
//
//   2. Configurable published lists (Railgun, OFAC SDN, …) fetched from an
//      operator-supplied URL. No URL is hardcoded — the operator vets the
//      source and sets it via env (RAILGUN_BLOCKLIST_URL / OFAC_BLOCKLIST_URL).
//
// Default runtime: fetch only, no signing (the contest signer is separate).

// ─── Chainalysis sanctions oracle ──────────────────────────────────────────

// Canonical oracle on Ethereum mainnet. Same `id()` keccak the shield
// indexer uses for topics.
const ORACLE_CHAIN_ID = 1;
const ORACLE_SUBDOMAIN = "eth-mainnet"; // Alchemy subdomain for chainId 1
const ORACLE_ADDRESS = "0x40c57923924b5c5c5455c48d93317139addac8fb";
// A safe floor at/just before the oracle's 2022 deployment — a few extra
// empty windows cost nothing and guarantee we don't miss the initial list.
const ORACLE_DEPLOY_BLOCK = 14_000_000;

const TOPIC_ADDED = id("SanctionedAddressesAdded(address[])");
const TOPIC_REMOVED = id("SanctionedAddressesRemoved(address[])");

const WINDOW = 10_000; // blocks per eth_getLogs call
const MAX_WINDOWS_PER_RUN = 300; // ~3M blocks/run; backfill resumes via cursor
const CONFIRMATIONS = 12;

const abi = AbiCoder.defaultAbiCoder();

function decodeAddressArray(data: string): string[] {
  const [addrs] = abi.decode(["address[]"], data) as unknown as [string[]];
  return addrs.map((a) => a.toLowerCase());
}

/** Index the Chainalysis oracle's add/remove events from the cursor (or its
 *  deploy block on first run) up to MAX_WINDOWS_PER_RUN windows ahead. Run
 *  on-demand a few times for an instant backfill, then the hourly cron keeps
 *  it at head:
 *    pnpm convex run compliance/oracle:indexChainalysisOracle
 */
export const indexChainalysisOracle = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    fromBlock: number;
    toBlock: number;
    added: number;
    removed: number;
    caughtUp: boolean;
  }> => {
    const url = alchemyUrl(ORACLE_SUBDOMAIN);
    const key = `chainalysis:${ORACLE_CHAIN_ID}`;

    const headHex = await rpc<string>(url, "eth_blockNumber", []);
    const trailingHead = Math.max(0, Number(BigInt(headHex)) - CONFIRMATIONS);

    const cursor = await ctx.runQuery(internal.compliance.store._cursorFor, {
      key,
    });
    const fromBlock = (cursor ?? ORACLE_DEPLOY_BLOCK - 1) + 1;
    if (fromBlock > trailingHead) {
      return {
        fromBlock,
        toBlock: trailingHead,
        added: 0,
        removed: 0,
        caughtUp: true,
      };
    }

    let added = 0;
    let removed = 0;
    let walk = fromBlock;
    let windows = 0;
    while (walk <= trailingHead && windows < MAX_WINDOWS_PER_RUN) {
      const to = Math.min(trailingHead, walk + WINDOW - 1);
      const logs = await rpc<
        Array<{ topics: string[]; data: string }>
      >(url, "eth_getLogs", [
        {
          fromBlock: "0x" + walk.toString(16),
          toBlock: "0x" + to.toString(16),
          address: ORACLE_ADDRESS,
          topics: [[TOPIC_ADDED, TOPIC_REMOVED]],
        },
      ]);

      for (const log of logs) {
        const t0 = log.topics[0]?.toLowerCase();
        const addrs = decodeAddressArray(log.data);
        if (t0 === TOPIC_ADDED.toLowerCase()) {
          for (const a of addrs) {
            await ctx.runMutation(internal.compliance.store._upsertBlocked, {
              address: a,
              source: "chainalysis",
              reason: "Chainalysis sanctions oracle",
            });
            added += 1;
          }
        } else if (t0 === TOPIC_REMOVED.toLowerCase()) {
          for (const a of addrs) {
            await ctx.runMutation(
              internal.compliance.store._removeBlockedExact,
              { address: a, source: "chainalysis" },
            );
            removed += 1;
          }
        }
      }

      await ctx.runMutation(internal.compliance.store._setCursor, {
        key,
        lastIndexedBlock: to,
      });
      walk = to + 1;
      windows += 1;
    }

    return {
      fromBlock,
      toBlock: walk - 1,
      added,
      removed,
      caughtUp: walk > trailingHead,
    };
  },
});

// ─── Configurable published lists (Railgun / OFAC / …) ─────────────────────

const ADDR_RE = /0x[0-9a-fA-F]{40}/g;

/** Fetch a published address list and upsert it under `source`. Accepts a
 *  JSON array of address strings, `{ addresses: [...] }`, an array of
 *  objects with an `address` field, or plain text — any 0x… address found
 *  is ingested. Run with an operator-vetted URL:
 *    pnpm convex run compliance/oracle:ingestAddressList \
 *      '{"url":"https://…","source":"railgun","reason":"Railgun blocklist"}'
 */
export const ingestAddressList = internalAction({
  args: { url: v.string(), source: v.string(), reason: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ source: string; ingested: number }> => {
    const res = await fetch(args.url);
    if (!res.ok) throw new Error(`ingest fetch ${res.status} for ${args.url}`);
    const text = await res.text();

    // Pull every address out of the body, whatever its shape, then dedupe.
    const found = new Set<string>();
    for (const m of text.matchAll(ADDR_RE)) found.add(m[0].toLowerCase());

    const reason = args.reason ?? `${args.source} blocklist`;
    let ingested = 0;
    for (const a of found) {
      await ctx.runMutation(internal.compliance.store._upsertBlocked, {
        address: a,
        source: args.source,
        reason,
      });
      ingested += 1;
    }
    return { source: args.source, ingested };
  },
});

/** Cron entry: ingest every configured published list. URLs come from env so
 *  no third-party source is baked into the repo. No-op when none are set. */
export const ingestConfiguredLists = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ran: string[] }> => {
    const sources: Array<{ env: string; source: string; reason: string }> = [
      { env: "RAILGUN_BLOCKLIST_URL", source: "railgun", reason: "Railgun blocklist" },
      { env: "OFAC_BLOCKLIST_URL", source: "ofac", reason: "OFAC SDN list" },
    ];
    const ran: string[] = [];
    for (const s of sources) {
      const url = process.env[s.env];
      if (!url) continue;
      try {
        await ctx.runAction(internal.compliance.oracle.ingestAddressList, {
          url,
          source: s.source,
          reason: s.reason,
        });
        ran.push(s.source);
      } catch (e) {
        console.warn(
          `[compliance] list ingest failed for ${s.source}: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { ran };
  },
});

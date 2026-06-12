import { id as ethersId } from "ethers";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { alchemyUrl, rpc } from "../lib/alchemy";
import {
  ALL_TOPICS,
  classifySelector,
  decodeLog,
  type RawLog,
} from "./events";
import type { IndexerDeployment } from "./store";

// Per-deployment shield-queue indexer. Fans out one polling pass per
// enabled `pampaloDeployments` row, fetches the relevant logs via the
// shared Alchemy RPC proxy, decodes each event, and dispatches into
// the store mutations.
//
// Cadence: 1-minute cron + self-scheduled +30s shadow tick, mirroring
// `prices/refresh.ts`. See SHIELD_FLOW.md §5.

const SHADOW_DELAY_MS = 30_000;

// Alchemy caps `eth_getLogs` block ranges. 10_000 is comfortably under
// every plan tier's hard cap and keeps a single call response under a
// few MB even on Pampalo-busy chains.
const MAX_BLOCKS_PER_CALL = 10_000;

// If the cursor is still at 0 (fresh `pampaloDeployments` row) we don't
// want to scan from genesis — testnet chains are tens of millions of
// blocks deep. Bootstrap by jumping the cursor to the current head
// minus this many blocks; older shield events (if any exist) are not
// indexed in v1. Set to leave a generous buffer for "shield happened
// minutes before seed".
const COLD_START_TRAIL = 5_000;

type RefreshSummary = {
  deployments: number;
  logsIngested: number;
  rangeAdvanced: number;
};

export const refreshShieldQueue = internalAction({
  args: {
    skipShadow: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<RefreshSummary> => {
    const deployments: IndexerDeployment[] = await ctx.runQuery(
      internal.shieldQueue.store._enabledDeployments,
      {},
    );

    // Schedule the shadow tick early so a hiccup downstream doesn't
    // break the cadence.
    if (!args.skipShadow) {
      await ctx.scheduler.runAfter(
        SHADOW_DELAY_MS,
        internal.shieldQueue.refresh.refreshShieldQueue,
        { skipShadow: true },
      );
    }

    let logsIngested = 0;
    let rangeAdvanced = 0;

    for (const d of deployments) {
      try {
        const ingested = await indexOneDeployment(ctx, d);
        logsIngested += ingested.logCount;
        rangeAdvanced += ingested.rangeAdvanced;
      } catch (e) {
        console.warn(
          `shieldQueue.refresh: deployment ${d._id} (chain ${d.chainId}) failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return {
      deployments: deployments.length,
      logsIngested,
      rangeAdvanced,
    };
  },
});

// Manual one-shot. Public so the /sentry "Refresh" button can call it
// from the client (SHIELD_FLOW.md §10.8). Spam protection is layered:
// the route has a 5s client-side throttle, and even bypassing that
// just causes redundant `eth_getLogs` calls — the indexer dedupes on
// upsert and the cursor only advances when blocks actually exist.
// Alchemy quota is the only real cost.
export const refreshShieldQueueNow = action({
  args: {},
  handler: async (ctx): Promise<unknown> =>
    await ctx.runAction(internal.shieldQueue.refresh.refreshShieldQueue, {
      skipShadow: true,
    }),
});

// ─── Per-deployment indexing ─────────────────────────────────────────────

type IndexingResult = { logCount: number; rangeAdvanced: number };

async function indexOneDeployment(
  ctx: ActionCtx,
  d: IndexerDeployment,
): Promise<IndexingResult> {
  const url = alchemyUrl(d.alchemySubdomain);

  // Resolve the current head and decide [fromBlock, toBlock].
  const headHex = await rpc<string>(url, "eth_blockNumber", []);
  const head = Number(BigInt(headHex));
  const trailingHead = Math.max(0, head - d.confirmationDepth);

  let fromBlock = d.lastIndexedBlock + 1;

  // Cold-start: if the cursor is at 0 and the chain is far ahead, jump
  // forward so we don't try to scan millions of blocks. Documented
  // behaviour: events emitted before this point are not indexed.
  if (d.lastIndexedBlock === 0 && trailingHead > COLD_START_TRAIL) {
    fromBlock = trailingHead - COLD_START_TRAIL;
  }

  if (fromBlock > trailingHead) {
    return { logCount: 0, rangeAdvanced: 0 };
  }

  let logCount = 0;
  let lastBlockProcessed = d.lastIndexedBlock;

  // Walk in MAX_BLOCKS_PER_CALL-sized windows. Most ticks will do one
  // call; the cold-start tick does several. Each window advances the
  // cursor so a mid-loop failure doesn't lose forward progress.
  let cursor = fromBlock;
  while (cursor <= trailingHead) {
    const toBlock = Math.min(trailingHead, cursor + MAX_BLOCKS_PER_CALL - 1);

    const logs = await rpc<RawLog[]>(url, "eth_getLogs", [
      {
        fromBlock: "0x" + cursor.toString(16),
        toBlock: "0x" + toBlock.toString(16),
        address: d.pampalo,
        topics: [ALL_TOPICS],
      },
    ]);

    // Cache eth_getTransactionByHash results per tx hash within this
    // window — multiple resolution events from the same tx (rare but
    // possible) would otherwise duplicate the RPC.
    const txFromCache = new Map<string, TxMeta>();

    for (const log of logs) {
      const decoded = decodeLog(log);
      if (!decoded) continue;

      try {
        switch (decoded.kind) {
          case "ShieldQueued": {
            await ctx.runMutation(
              internal.shieldQueue.store._upsertShieldQueueEntry,
              {
                deploymentId: d._id,
                pendingId: decoded.pendingId,
                shielder: decoded.shielder,
                asset: decoded.asset,
                amount: decoded.amount,
                leafCommitment: decoded.leafCommitment,
                unlockTime: decoded.unlockTime,
                // ShieldCapCharged is emitted alongside ShieldQueued —
                // ideally we'd snap usdCentsCharged off it. The v1
                // indexer doesn't index that event yet, so we store 0
                // and let the slider re-read on-chain when it needs the
                // canonical cap math. Worth fixing in a follow-up.
                usdCentsCharged: 0,
                encryptedPayload: decoded.encryptedPayload,
                queuedTxHash: log.transactionHash,
              },
            );
            break;
          }

          case "ShieldExecuted":
          case "ShieldCancelled":
          case "ShieldContested": {
            const txMeta = await getTxMeta(
              url,
              log.transactionHash,
              log.blockHash,
              txFromCache,
            );
            await ctx.runMutation(
              internal.shieldQueue.store._resolveShieldQueueEntry,
              {
                deploymentId: d._id,
                pendingId: decoded.pendingId,
                state:
                  decoded.kind === "ShieldExecuted"
                    ? "executed"
                    : decoded.kind === "ShieldCancelled"
                      ? "cancelled"
                      : "contested",
                resolvedTxHash: log.transactionHash,
                resolvedBy:
                  decoded.kind === "ShieldExecuted" ? txMeta.from : decoded.by,
                resolvedAt: txMeta.blockTime,
                contestReason:
                  decoded.kind === "ShieldContested"
                    ? decoded.reason
                    : undefined,
              },
            );
            break;
          }

          case "AssetSupported": {
            await ctx.runMutation(internal.shieldQueue.store._upsertAsset, {
              deploymentId: d._id,
              tokenAddress: decoded.asset,
              oracle: decoded.oracle,
              enabled: true,
            });
            break;
          }

          case "AssetDisabled": {
            await ctx.runMutation(internal.shieldQueue.store._upsertAsset, {
              deploymentId: d._id,
              tokenAddress: decoded.asset,
              // oracle gets preserved on disable in store._upsertAsset
              oracle: "0x0000000000000000000000000000000000000000",
              enabled: false,
            });
            break;
          }

          case "LeafInserted": {
            await ctx.runMutation(internal.shieldQueue.store._upsertLeaf, {
              deploymentId: d._id,
              epoch: decoded.epoch,
              leafIndex: decoded.leafIndex,
              leafCommitment: decoded.leafCommitment,
              insertedTxHash: log.transactionHash,
            });
            break;
          }

          case "NotePayload": {
            await ctx.runMutation(
              internal.shieldQueue.store._upsertNotePayload,
              {
                deploymentId: d._id,
                encryptedPayload: decoded.encryptedPayload,
                txHash: log.transactionHash,
                blockNumber: Number(BigInt(log.blockNumber)),
                logIndex: Number(BigInt(log.logIndex)),
              },
            );
            // Activity feed: attach a shortened payload preview to the tx's
            // row (transfer / unshield only; shieldNative payloads classify
            // as "shield"/"other" and are skipped).
            {
              const meta = await getTxMeta(
                url,
                log.transactionHash,
                log.blockHash,
                txFromCache,
              );
              const kind = classifySelector(meta.selector);
              if (kind === "transfer" || kind === "unshield") {
                await ctx.runMutation(internal.shieldQueue.store._upsertActivity, {
                  deploymentId: d._id,
                  txHash: log.transactionHash,
                  kind,
                  from: meta.from,
                  blockNumber: Number(BigInt(log.blockNumber)),
                  blockTime: meta.blockTime,
                  payloadPreview: shortenPayload(decoded.encryptedPayload),
                });
              }
            }
            break;
          }

          case "NullifierUsed": {
            // Universal private-spend signal — classify the tx and record
            // (or confirm) its activity row. The bare `unshield` path emits
            // no leaf/payload, so this is the only way it shows up.
            const meta = await getTxMeta(
              url,
              log.transactionHash,
              log.blockHash,
              txFromCache,
            );
            const kind = classifySelector(meta.selector);
            if (kind === "transfer" || kind === "unshield") {
              await ctx.runMutation(internal.shieldQueue.store._upsertActivity, {
                deploymentId: d._id,
                txHash: log.transactionHash,
                kind,
                from: meta.from,
                blockNumber: Number(BigInt(log.blockNumber)),
                blockTime: meta.blockTime,
              });
            }
            // Record the spent nullifier itself (public set; lets the
            // client reconcile its own notes' spend status client-side —
            // ADR 0019). Unconditional: every NullifierUsed is a spend.
            await ctx.runMutation(internal.shieldQueue.store._upsertNullifier, {
              deploymentId: d._id,
              nullifier: decoded.nullifier,
              blockNumber: Number(BigInt(log.blockNumber)),
              txHash: log.transactionHash,
            });
            break;
          }
        }
        logCount += 1;
      } catch (e) {
        // One bad log shouldn't kill the whole window. Log and move on;
        // the next tick will re-ingest if the cursor doesn't advance.
        console.warn(
          `shieldQueue.refresh: failed to handle ${decoded.kind} pendingId=${
            "pendingId" in decoded ? decoded.pendingId : "n/a"
          }: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await ctx.runMutation(internal.shieldQueue.store._advanceCursor, {
      deploymentId: d._id,
      toBlock,
    });
    lastBlockProcessed = toBlock;
    cursor = toBlock + 1;
  }

  return {
    logCount,
    rangeAdvanced: Math.max(0, lastBlockProcessed - d.lastIndexedBlock),
  };
}

// ─── tx-meta helpers ─────────────────────────────────────────────────────

// First 6 + last 4 bytes of an ECIES blob, for the activity feed preview.
function shortenPayload(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length <= 20) return "0x" + hex;
  return "0x" + hex.slice(0, 12) + "…" + hex.slice(-8);
}

type TxMeta = { from: string; blockTime: number; selector: string };

async function getTxMeta(
  url: string,
  txHash: string,
  blockHash: string,
  cache: Map<string, TxMeta>,
): Promise<TxMeta> {
  const cached = cache.get(txHash);
  if (cached) return cached;

  const tx = await rpc<{ from: string; input?: string } | null>(
    url,
    "eth_getTransactionByHash",
    [txHash],
  );
  if (!tx) {
    throw new Error(`eth_getTransactionByHash returned null for ${txHash}`);
  }

  const block = await rpc<{ timestamp: string } | null>(
    url,
    "eth_getBlockByHash",
    [blockHash, false],
  );
  if (!block) {
    throw new Error(`eth_getBlockByHash returned null for ${blockHash}`);
  }

  // 0x + 8 hex = the 4-byte function selector. Drives activity classification.
  const selector = (tx.input ?? "0x").slice(0, 10);
  const meta: TxMeta = {
    from: tx.from,
    blockTime: Number(BigInt(block.timestamp)),
    selector,
  };
  cache.set(txHash, meta);
  return meta;
}

// ─── One-off nullifier backfill ──────────────────────────────────────────
// The live indexer only started recording nullifiers (into pampaloNullifiers)
// from this change onward; NullifierUsed events emitted before the cursor
// passed them aren't captured. This scans [fromBlock, head] for the
// NullifierUsed topic and upserts them, WITHOUT touching the live cursor.
// Run once per deployment after deploy, passing its deploy block:
//   npx convex run shieldQueue/refresh:backfillNullifiers '{"chainId":8453,"fromBlock":47237162}'
// Idempotent (upsert dedupes on (deploymentId, nullifier)) — safe to re-run,
// e.g. with a higher fromBlock if a single run runs long.
const NULLIFIER_USED_TOPIC = ethersId("NullifierUsed(bytes32)");

export const backfillNullifiers = internalAction({
  args: { chainId: v.number(), fromBlock: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ scannedTo: number; inserted: number }> => {
    const dep = await ctx.runQuery(
      internal.shieldQueue.store._deploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep) {
      throw new Error(
        `backfillNullifiers: no enabled deployment for chain ${args.chainId}`,
      );
    }
    const url = alchemyUrl(dep.alchemySubdomain);
    const head = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));

    let cursor = args.fromBlock;
    let inserted = 0;
    while (cursor <= head) {
      const toBlock = Math.min(head, cursor + MAX_BLOCKS_PER_CALL - 1);
      const logs = await rpc<RawLog[]>(url, "eth_getLogs", [
        {
          fromBlock: "0x" + cursor.toString(16),
          toBlock: "0x" + toBlock.toString(16),
          address: dep.pampalo,
          topics: [NULLIFIER_USED_TOPIC],
        },
      ]);
      for (const log of logs) {
        await ctx.runMutation(internal.shieldQueue.store._upsertNullifier, {
          deploymentId: dep.deploymentId,
          nullifier: (log.topics[1] ?? "0x").toLowerCase(),
          blockNumber: Number(BigInt(log.blockNumber)),
          txHash: log.transactionHash,
        });
        inserted += 1;
      }
      cursor = toBlock + 1;
    }
    return { scannedTo: head, inserted };
  },
});

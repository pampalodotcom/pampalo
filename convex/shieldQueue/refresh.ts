import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { alchemyUrl, rpc } from "../lib/alchemy";
import { ALL_TOPICS, decodeLog, type RawLog } from "./events";
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
    const txFromCache = new Map<string, { from: string; blockTime: number }>();

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

async function getTxMeta(
  url: string,
  txHash: string,
  blockHash: string,
  cache: Map<string, { from: string; blockTime: number }>,
): Promise<{ from: string; blockTime: number }> {
  const cached = cache.get(txHash);
  if (cached) return cached;

  const tx = await rpc<{ from: string } | null>(
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

  const meta = {
    from: tx.from,
    blockTime: Number(BigInt(block.timestamp)),
  };
  cache.set(txHash, meta);
  return meta;
}

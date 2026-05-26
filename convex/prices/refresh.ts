import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import {
  alchemyUrl,
  rpcBatch,
  type RpcRequest,
  type RpcResponse,
} from "../lib/alchemy";

// Polls Chainlink price feeds + per-network gas prices and writes the
// results back through internal mutations. Runs on cron (see crons.ts).
//
// No ethers / web3 dependency — everything is raw JSON-RPC + manual ABI
// encoding/decoding so this action runs in the default Convex runtime.

const AGGREGATOR_LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";

// Decode the int256 / uint80 / uint256 tuple returned by latestRoundData().
// The return ABI is (uint80, int256, uint256, uint256, uint80). Each slot
// is 32 bytes (64 hex chars). We only need answer (slot 1) and updatedAt
// (slot 3). `answer` is two's-complement signed; the rest are unsigned.
function decodeLatestRoundData(hex: string): {
  answer: bigint;
  updatedAt: bigint;
} {
  if (!hex || !hex.startsWith("0x")) {
    throw new Error(`Bad latestRoundData hex: ${hex}`);
  }
  const data = hex.slice(2);
  if (data.length < 64 * 5) {
    throw new Error(`latestRoundData payload too short: ${data.length} chars`);
  }
  const slot = (i: number) => data.slice(i * 64, (i + 1) * 64);
  const answer = decodeInt256(slot(1));
  const updatedAt = BigInt(`0x${slot(3)}`);
  return { answer, updatedAt };
}

function decodeInt256(hex64: string): bigint {
  // Two's complement: if the high bit is set, value is negative.
  const u = BigInt(`0x${hex64}`);
  const MAX = 1n << 256n;
  const SIGN_BIT = 1n << 255n;
  return u >= SIGN_BIT ? u - MAX : u;
}

// ─── Prices ──────────────────────────────────────────────────────────────

type RefreshSummary = {
  fetched: number;
  written: number;
  appended?: number;
  dedupedHistory?: number;
};

// Convex `crons.interval` has a 1-minute floor. To run prices every 30s,
// the cron fires once a minute and this action self-schedules a second
// copy 30s in. Two ticks per minute, no further cron config needed.
//
// If a tick errors, the scheduler chain isn't broken — the cron will
// still fire the next minute and reset the cadence. The 30s shadow is
// "best effort", not load-bearing.
const SHADOW_DELAY_MS = 30_000;

export const refreshPrices = internalAction({
  args: {
    // When true, this invocation skips scheduling its own shadow copy.
    // The cron-triggered tick always schedules; the shadow tick doesn't.
    skipShadow: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<RefreshSummary> => {
    const feeds: Array<{
      shortId: string;
      aggregator: string;
      feedDecimals: number;
      chainId: number | null;
      alchemySubdomain: string | null;
    }> = await ctx.runQuery(internal.prices.feeds._enabledFeeds, {});

    if (feeds.length === 0) return { fetched: 0, written: 0 };

    // All fiat-pair feeds we use live on Ethereum mainnet per the design
    // decision, so it's almost always a single batch. The code still
    // groups by subdomain in case a feed gets added on another chain.
    const byHost = new Map<string, typeof feeds>();
    for (const f of feeds) {
      if (!f.alchemySubdomain) continue;
      const bucket = byHost.get(f.alchemySubdomain) ?? [];
      bucket.push(f);
      byHost.set(f.alchemySubdomain, bucket);
    }

    const fetchedAt = Date.now();
    const results: Array<{
      shortId: string;
      answer: string;
      feedDecimals: number;
      feedUpdatedAt: number;
      fetchedAt: number;
    }> = [];

    for (const [subdomain, bucket] of byHost.entries()) {
      const url = alchemyUrl(subdomain);
      const batch: Array<RpcRequest> = bucket.map((f, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "eth_call",
        params: [
          { to: f.aggregator, data: AGGREGATOR_LATEST_ROUND_DATA_SELECTOR },
          "latest",
        ],
      }));
      const responses = await rpcBatch<string>(url, batch);
      for (let i = 0; i < bucket.length; i++) {
        const f = bucket[i];
        const resp = responses.find((r) => r.id === i) ?? responses[i];
        if (resp.error || !resp.result) {
          console.warn(
            `Skipping ${f.shortId}: ${resp.error?.message ?? "no result"}`,
          );
          continue;
        }
        try {
          const { answer, updatedAt } = decodeLatestRoundData(resp.result);
          results.push({
            shortId: f.shortId,
            answer: answer.toString(),
            feedDecimals: f.feedDecimals,
            feedUpdatedAt: Number(updatedAt), // sec since epoch, fits in JS number
            fetchedAt,
          });
        } catch (e) {
          console.warn(`Decode failed for ${f.shortId}:`, e);
        }
      }
    }

    // Schedule the +30s shadow tick before writing, so a write hiccup
    // doesn't break the cadence. Skip if this *is* the shadow tick.
    if (!args.skipShadow) {
      await ctx.scheduler.runAfter(
        SHADOW_DELAY_MS,
        internal.prices.refresh.refreshPrices,
        { skipShadow: true },
      );
    }

    if (results.length === 0) return { fetched: feeds.length, written: 0 };
    const { appended, dedupedHistory }: { appended: number; dedupedHistory: number } =
      await ctx.runMutation(internal.prices.feeds._writeRefresh, { results });
    return {
      fetched: feeds.length,
      written: results.length,
      appended,
      dedupedHistory,
    };
  },
});

// ─── Gas ─────────────────────────────────────────────────────────────────

export const refreshGas = internalAction({
  args: {},
  handler: async (ctx): Promise<RefreshSummary> => {
    const networks: Array<{
      _id: Id<"supportedNetworks">;
      chainId: number;
      alchemySubdomain: string;
    }> = await ctx.runQuery(internal.prices.gas._enabledNetworks, {});

    if (networks.length === 0) return { fetched: 0, written: 0 };

    const fetchedAt = Date.now();
    const results: Array<{
      networkId: Id<"supportedNetworks">;
      gasPriceWei: string;
      baseFeeWei?: string;
      priorityFeeWei?: string;
      fetchedAt: number;
    }> = [];

    // One RPC per network — they're on different hosts so no batching.
    // Fetch both eth_gasPrice and eth_feeHistory in a per-host batch.
    await Promise.all(
      networks.map(async (n) => {
        try {
          const url = alchemyUrl(n.alchemySubdomain);
          const batch: Array<RpcRequest> = [
            { jsonrpc: "2.0", id: 0, method: "eth_gasPrice", params: [] },
            {
              jsonrpc: "2.0",
              id: 1,
              method: "eth_feeHistory",
              // 1 block, latest, p50 reward percentile
              params: ["0x1", "latest", [50]],
            },
          ];
          const resps = await rpcBatch<unknown>(url, batch);
          const gasPriceResp = resps.find((r) => r.id === 0);
          const feeHistoryResp = resps.find((r) => r.id === 1) as
            | RpcResponse<{
                baseFeePerGas?: string[];
                reward?: string[][];
              }>
            | undefined;
          if (
            !gasPriceResp ||
            gasPriceResp.error ||
            typeof gasPriceResp.result !== "string"
          ) {
            console.warn(
              `Skipping gas for chain ${n.chainId}: ${gasPriceResp?.error?.message ?? "no result"}`,
            );
            return;
          }
          const gasPriceWei = BigInt(gasPriceResp.result).toString();
          let baseFeeWei: string | undefined;
          let priorityFeeWei: string | undefined;
          if (feeHistoryResp && !feeHistoryResp.error && feeHistoryResp.result) {
            const fh = feeHistoryResp.result;
            // baseFeePerGas has length = blocks+1 — index 0 is "latest base fee".
            const bf = fh.baseFeePerGas?.[0];
            if (bf) baseFeeWei = BigInt(bf).toString();
            const r = fh.reward?.[0]?.[0];
            if (r) priorityFeeWei = BigInt(r).toString();
          }
          results.push({
            networkId: n._id,
            gasPriceWei,
            baseFeeWei,
            priorityFeeWei,
            fetchedAt,
          });
        } catch (e) {
          console.warn(`Gas fetch failed for chain ${n.chainId}:`, e);
        }
      }),
    );

    if (results.length === 0) return { fetched: networks.length, written: 0 };
    const { appended, dedupedHistory }: { appended: number; dedupedHistory: number } =
      await ctx.runMutation(internal.prices.gas._writeRefresh, { results });
    return {
      fetched: networks.length,
      written: results.length,
      appended,
      dedupedHistory,
    };
  },
});

// Optional one-shot helpers callable from the CLI for manual testing:
//   pnpm convex run prices/refresh:refreshPricesNow
//   pnpm convex run prices/refresh:refreshGasNow
export const refreshPricesNow = internalAction({
  args: {},
  handler: async (ctx): Promise<unknown> =>
    // skipShadow so manual runs don't spawn a self-scheduling chain.
    await ctx.runAction(internal.prices.refresh.refreshPrices, { skipShadow: true }),
});

export const refreshGasNow = internalAction({
  args: {},
  handler: async (ctx): Promise<unknown> =>
    await ctx.runAction(internal.prices.refresh.refreshGas, {}),
});

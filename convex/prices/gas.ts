import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";

// ─── Public reads ────────────────────────────────────────────────────────

export const latestForChain = query({
  args: { chainId: v.number() },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) return null;
    const row = await ctx.db
      .query("latestGas")
      .withIndex("by_networkId", (q) => q.eq("networkId", network._id))
      .unique();
    return row
      ? {
          chainId: network.chainId,
          gasPriceWei: row.gasPriceWei,
          baseFeeWei: row.baseFeeWei,
          priorityFeeWei: row.priorityFeeWei,
          fetchedAt: row.fetchedAt,
        }
      : null;
  },
});

export const listLatest = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("latestGas").take(50);
    const enriched: Array<{
      chainId: number;
      gasPriceWei: string;
      baseFeeWei?: string;
      priorityFeeWei?: string;
      fetchedAt: number;
    }> = [];
    for (const r of rows) {
      const net = await ctx.db.get(r.networkId);
      if (!net) continue;
      enriched.push({
        chainId: net.chainId,
        gasPriceWei: r.gasPriceWei,
        baseFeeWei: r.baseFeeWei,
        priorityFeeWei: r.priorityFeeWei,
        fetchedAt: r.fetchedAt,
      });
    }
    return enriched;
  },
});

export const historyForChain = query({
  args: {
    chainId: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    return await ctx.db
      .query("gasHistory")
      .withIndex("by_n_t", (q) => q.eq("n", network._id))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// ─── Internal helpers for the refresh action ─────────────────────────────

export const _enabledNetworks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("supportedNetworks").take(50);
    return rows
      .filter((r) => r.enabled)
      .map((r) => ({
        _id: r._id,
        chainId: r.chainId,
        alchemySubdomain: r.alchemySubdomain,
      }));
  },
});

export const _writeRefresh = internalMutation({
  args: {
    results: v.array(
      v.object({
        networkId: v.id("supportedNetworks"),
        gasPriceWei: v.string(),
        baseFeeWei: v.optional(v.string()),
        priorityFeeWei: v.optional(v.string()),
        fetchedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let appended = 0;
    let dedupedHistory = 0;
    for (const r of args.results) {
      const networkId = r.networkId;
      const existing = await ctx.db
        .query("latestGas")
        .withIndex("by_networkId", (q) => q.eq("networkId", networkId))
        .unique();

      if (existing) {
        await ctx.db.replace(existing._id, r);
      } else {
        await ctx.db.insert("latestGas", r);
      }

      if (existing && existing.gasPriceWei === r.gasPriceWei) {
        dedupedHistory += 1;
        continue;
      }
      await ctx.db.insert("gasHistory", {
        n: networkId,
        g: r.gasPriceWei,
        t: r.fetchedAt,
      });
      appended += 1;
    }
    return { appended, dedupedHistory };
  },
});

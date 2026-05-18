import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";

// ─── Public reads ────────────────────────────────────────────────────────

export const listLatest = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("latestPrices").take(100);
    return rows.map((r) => ({
      shortId: r.shortId,
      answer: r.answer,
      feedDecimals: r.feedDecimals,
      feedUpdatedAt: r.feedUpdatedAt,
      fetchedAt: r.fetchedAt,
    }));
  },
});

export const getLatest = query({
  args: { shortId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("latestPrices")
      .withIndex("by_shortId", (q) => q.eq("shortId", args.shortId))
      .unique();
    return row
      ? {
          shortId: row.shortId,
          answer: row.answer,
          feedDecimals: row.feedDecimals,
          feedUpdatedAt: row.feedUpdatedAt,
          fetchedAt: row.fetchedAt,
        }
      : null;
  },
});

export const historyForFeed = query({
  args: {
    shortId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("priceHistory")
      .withIndex("by_s_t", (q) => q.eq("s", args.shortId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// ─── Internal writers (called by the refresh action) ─────────────────────
// One mutation per refresh tick, batching all four feeds. Dedupe lives
// here so the action stays stateless — we compare against whatever
// latestPrices already holds.

export const _enabledFeeds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("priceFeeds").take(50);
    const enabled = rows.filter((r) => r.enabled);
    // Join the network row so the action knows which chain to call.
    return await Promise.all(
      enabled.map(async (f) => {
        const net = await ctx.db.get(f.networkId);
        return {
          shortId: f.shortId,
          aggregator: f.aggregator,
          feedDecimals: f.feedDecimals,
          chainId: net?.chainId ?? null,
          alchemySubdomain: net?.alchemySubdomain ?? null,
        };
      }),
    );
  },
});

export const _writeRefresh = internalMutation({
  args: {
    results: v.array(
      v.object({
        shortId: v.string(),
        answer: v.string(),
        feedDecimals: v.number(),
        feedUpdatedAt: v.number(),
        fetchedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let appended = 0;
    let dedupedHistory = 0;
    for (const r of args.results) {
      const existing = await ctx.db
        .query("latestPrices")
        .withIndex("by_shortId", (q) => q.eq("shortId", r.shortId))
        .unique();

      // Upsert latest — always written so fetchedAt advances even on dedupe.
      if (existing) {
        await ctx.db.replace(existing._id, r);
      } else {
        await ctx.db.insert("latestPrices", r);
      }

      // Dedupe history: only append when the answer actually moved. The
      // feedUpdatedAt round timestamp also being unchanged is a stronger
      // signal (Chainlink only writes a new round on movement), but the
      // answer comparison covers the case where decimals shift too.
      if (existing && existing.answer === r.answer) {
        dedupedHistory += 1;
        continue;
      }
      await ctx.db.insert("priceHistory", {
        s: r.shortId,
        a: r.answer,
        t: r.fetchedAt,
      });
      appended += 1;
    }
    return { appended, dedupedHistory };
  },
});

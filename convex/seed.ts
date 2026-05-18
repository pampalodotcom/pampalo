import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";

// CLI-callable seed mutations. Run via:
//   pnpm convex run seed:addNetwork '{...}'
//   pnpm convex run seed:addToken '{...}'
//   pnpm convex run seed:addPriceFeed '{...}'
//
// These are public `mutation`s so the dashboard / CLI can invoke them
// without an auth token. Re-running with the same chainId / shortId / token
// address is a no-op (upsert), so scripts are idempotent.

export const addNetwork = mutation({
  args: {
    chainId: v.number(),
    name: v.string(),
    alchemySubdomain: v.string(),
    nativeSymbol: v.string(),
    nativeDecimals: v.number(),
    isNative: v.boolean(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    const payload = {
      chainId: args.chainId,
      name: args.name,
      alchemySubdomain: args.alchemySubdomain,
      nativeSymbol: args.nativeSymbol,
      nativeDecimals: args.nativeDecimals,
      isNative: args.isNative,
      enabled: args.enabled ?? true,
    };
    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("supportedNetworks", payload);
  },
});

export const addToken = mutation({
  args: {
    chainId: v.number(),
    address: v.string(), // any case; stored lowercased
    symbol: v.string(),
    decimals: v.number(),
    priceFeedShortId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) {
      throw new Error(`No supportedNetworks row for chainId ${args.chainId}`);
    }
    const addr = args.address.toLowerCase();
    const existing = await ctx.db
      .query("supportedTokens")
      .withIndex("by_networkId_and_address", (q) =>
        q.eq("networkId", network._id).eq("address", addr),
      )
      .unique();
    const payload = {
      networkId: network._id,
      address: addr,
      symbol: args.symbol,
      decimals: args.decimals,
      priceFeedShortId: args.priceFeedShortId,
    };
    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("supportedTokens", payload);
  },
});

export const addPriceFeed = mutation({
  args: {
    shortId: v.string(), // "eth/usd", "usd/aud", …
    chainId: v.number(), // chain the aggregator lives on (1 for mainnet)
    aggregator: v.string(),
    feedDecimals: v.number(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) {
      throw new Error(`No supportedNetworks row for chainId ${args.chainId}`);
    }
    const existing = await ctx.db
      .query("priceFeeds")
      .withIndex("by_shortId", (q) => q.eq("shortId", args.shortId))
      .unique();
    const payload = {
      shortId: args.shortId,
      networkId: network._id,
      aggregator: args.aggregator.toLowerCase(),
      feedDecimals: args.feedDecimals,
      enabled: args.enabled ?? true,
    };
    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("priceFeeds", payload);
  },
});

// Bulk-seed the four pairs from PRICE.md against Ethereum mainnet. Call
// after `addNetwork` for chainId 1.
export const seedDefaultPriceFeeds = mutation({
  args: {},
  handler: async (ctx) => {
    // Chainlink mainnet aggregators (verified against docs.chain.link).
    // All four have feedDecimals = 8.
    const defaults: Array<{ shortId: string; aggregator: string }> = [
      // ETH / USD
      { shortId: "eth/usd", aggregator: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419" },
      // AUD / USD — we invert to USD/AUD client-side
      { shortId: "aud/usd", aggregator: "0x77f9710e7d0a19669a13c055f62cd80d313df022" },
      // CAD / USD — invert to USD/CAD client-side
      { shortId: "cad/usd", aggregator: "0xa34317db73e77d453b1b8d04550c44d10e981c8e" },
      // GBP / USD — invert to USD/GBP client-side
      { shortId: "gbp/usd", aggregator: "0x5c0ab2d9b5a7ed9f470386e82bb36a3613cdd4b5" },
    ];
    const mainnet = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", 1))
      .unique();
    if (!mainnet) {
      throw new Error(
        "Seed Ethereum mainnet (chainId 1) first with seed:addNetwork.",
      );
    }
    const ids = [];
    for (const f of defaults) {
      const existing = await ctx.db
        .query("priceFeeds")
        .withIndex("by_shortId", (q) => q.eq("shortId", f.shortId))
        .unique();
      const payload = {
        shortId: f.shortId,
        networkId: mainnet._id,
        aggregator: f.aggregator,
        feedDecimals: 8,
        enabled: true,
      };
      if (existing) {
        await ctx.db.replace(existing._id, payload);
        ids.push(existing._id);
      } else {
        ids.push(await ctx.db.insert("priceFeeds", payload));
      }
    }
    return ids;
  },
});

// Internal helper used by the refresh actions for upserts. Kept here so all
// write paths for the catalog tables live in one place.
export const _internalNoop = internalMutation({
  args: {},
  handler: async () => null,
});

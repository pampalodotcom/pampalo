import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";

// Dashboard / CLI-only seed mutations. Run via:
//   pnpm convex run seed:addNetwork '{...}'
//   pnpm convex run seed:addToken '{...}'
//   pnpm convex run seed:addPriceFeed '{...}'
//   pnpm convex run seed:seedAll        ← idempotent one-shot
//
// `internalMutation` so the public client API can't reach them — only the
// Convex dashboard "Run function" panel and the `convex run` CLI can.
// Re-running with the same chainId / shortId is an upsert for networks
// and price feeds. Token rows are insert-only: once a token exists for a
// (network, address), subsequent seeds leave it alone so any manual edits
// in the dashboard (e.g. roundTo tweaks, name fixes) survive.

// Native-token sentinel address. Matches the 1inch / OKX convention used
// elsewhere in EVM tooling. Stored lowercased.
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const addNetwork = internalMutation({
  args: {
    chainId: v.number(),
    name: v.string(),
    alchemySubdomain: v.string(),
    nativeSymbol: v.string(),
    nativeDecimals: v.number(),
    isNative: v.boolean(),
    lzEndpointId: v.optional(v.number()),
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
      lzEndpointId: args.lzEndpointId,
      enabled: args.enabled ?? true,
    };
    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("supportedNetworks", payload);
  },
});

export const addToken = internalMutation({
  args: {
    chainId: v.number(),
    address: v.string(), // any case; stored lowercased
    name: v.string(),
    symbol: v.string(),
    decimals: v.number(),
    isNative: v.optional(v.boolean()),
    roundTo: v.optional(v.number()),
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
    if (existing) {
      // Token already in the catalogue — leave it untouched.
      return existing._id;
    }
    return await ctx.db.insert("supportedTokens", {
      networkId: network._id,
      address: addr,
      name: args.name,
      symbol: args.symbol,
      decimals: args.decimals,
      isNative: args.isNative,
      roundTo: args.roundTo,
      priceFeedShortId: args.priceFeedShortId,
    });
  },
});

export const addPriceFeed = internalMutation({
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

// ─── Catalogues (kept in code so seeding is reproducible) ────────────────

type SeedNetwork = {
  chainId: number;
  name: string;
  alchemySubdomain: string;
  nativeSymbol: string;
  nativeDecimals: number;
  isNative: boolean;
  lzEndpointId?: number;
};

type SeedToken = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  isNative?: boolean;
  roundTo?: number;
  priceFeedShortId?: string;
};

const NETWORKS: SeedNetwork[] = [
  {
    chainId: 1,
    name: "Ethereum",
    alchemySubdomain: "eth-mainnet",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isNative: true,
    lzEndpointId: 30101,
  },
  {
    chainId: 8453,
    name: "Base",
    alchemySubdomain: "base-mainnet",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isNative: true,
    lzEndpointId: 30184,
  },
  {
    chainId: 11155111,
    name: "Sepolia",
    alchemySubdomain: "eth-sepolia",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isNative: true,
    lzEndpointId: 40101,
  },
  {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    alchemySubdomain: "arb-sepolia",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isNative: true,
    lzEndpointId: 40231,
  },
];

// AUDD has no direct Chainlink feed; the AUD/USD aggregator is used to
// price it (~1 AUDD ≈ 1 AUD). USDC is treated as USD client-side, so we
// don't bind it to a feed.
const TOKENS: SeedToken[] = [
  // ── Ethereum mainnet ──
  {
    chainId: 1,
    address: "0x4cCe605eD955295432958d8951D0B176C10720d5",
    name: "Australian Digital Dollar",
    symbol: "AUDD",
    decimals: 6,
    roundTo: 2,
    priceFeedShortId: "aud/usd",
  },
  {
    chainId: 1,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    roundTo: 2,
  },
  {
    chainId: 1,
    address: ETH_ADDRESS,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    isNative: true,
    roundTo: 5,
    priceFeedShortId: "eth/usd",
  },
  // ── Base ──
  {
    chainId: 8453,
    address: ETH_ADDRESS,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    isNative: true,
    roundTo: 5,
    priceFeedShortId: "eth/usd",
  },
  // Native (Circle-issued) USDC on Base. Distinct from USDbC
  // (bridged USDC, 0xd9aa…), which Circle now discourages — we only
  // surface the canonical token. USDC has no chainlink feed in our
  // catalogue; the swap UI prices it at $1, same as on mainnet.
  {
    chainId: 8453,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    roundTo: 2,
  },
  // ── Sepolia ──
  {
    chainId: 11155111,
    address: "0x237eEeE66266c72DBb7Ee2Aa84811666cE4EB815",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    roundTo: 2,
  },
  {
    chainId: 11155111,
    address: "0xd794125Bc226895b987845Ef768B8C104fAbecD5",
    name: "Australian Dollar Coin",
    symbol: "AUDD",
    decimals: 6,
    roundTo: 2,
    priceFeedShortId: "aud/usd",
  },
  {
    chainId: 11155111,
    address: ETH_ADDRESS,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    isNative: true,
    roundTo: 5,
    priceFeedShortId: "eth/usd",
  },
  // ── Arbitrum Sepolia ──
  {
    chainId: 421614,
    address: "0xA09599efa9a31036D20a9eEF07C69E77937E784E",
    name: "Australian Dollar Coin",
    symbol: "AUDD",
    decimals: 6,
    roundTo: 2,
    priceFeedShortId: "aud/usd",
  },
  {
    chainId: 421614,
    address: "0xD1CAD1C8CEEdeD7Ad65440fd643E2d9320c2bf51",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    roundTo: 2,
  },
  {
    chainId: 421614,
    address: ETH_ADDRESS,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    isNative: true,
    roundTo: 5,
    priceFeedShortId: "eth/usd",
  },
];

// Uniswap pool addresses (mainnet). Verified on Etherscan; v3 covers
// the standard fee tiers (500/3000/10000). Pools that don't exist as
// of writing (e.g. AUDD/USDC v3) are omitted — the `getPool` action
// falls back to a factory call, so missing rows just mean "compute on
// demand and cache later". Token addresses are stored lowercased and
// in canonical (token0 < token1) order.
//
// All addresses lowercased to match the schema's canonical form.
type SeedPool = {
  chainId: number;
  version: "v2" | "v3";
  token0: string; // < token1 lexicographically
  token1: string;
  fee?: number; // v3 only
  address: string;
};

const POOLS: SeedPool[] = [
  // ── Ethereum mainnet, v2 ──
  // USDC/WETH: USDC=0xa0b8…, WETH=0xc02a… → token0=USDC, token1=WETH
  {
    chainId: 1,
    version: "v2",
    token0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    address: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
  },
  // AUDD/WETH v2: AUDD=0x4cce…, WETH=0xc02a… → token0=AUDD, token1=WETH
  // No live v2 pool at time of seeding — left for factory fallback.
  //
  // AUDD/USDC v2: AUDD=0x4cce…, USDC=0xa0b8… → token0=USDC, token1=AUDD
  // No live v2 pool at time of seeding — left for factory fallback.

  // ── Ethereum mainnet, v3 ──
  // USDC/WETH 0.05%
  {
    chainId: 1,
    version: "v3",
    token0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    fee: 500,
    address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  },
  // USDC/WETH 0.3%
  {
    chainId: 1,
    version: "v3",
    token0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    fee: 3000,
    address: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
  },
  // USDC/WETH 1% (low liquidity but exists)
  {
    chainId: 1,
    version: "v3",
    token0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    fee: 10000,
    address: "0x7bea39867e4169dbe237d55c8242a8f2fcdcc387",
  },
  // AUDD pools on mainnet v3 are absent / very illiquid at time of
  // seeding. The factory fallback in `getPool` handles them: if
  // factory.getPool returns the zero address we surface { available:
  // false } to the caller, who can then try another fee tier or v2.
];

// Chainlink mainnet aggregators (verified against docs.chain.link).
// All four have feedDecimals = 8 and use base/quote in the shortId.
const PRICE_FEEDS = [
  // direct: ETH → USD
  { shortId: "eth/usd", aggregator: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419" },
  // inverted client-side: AUD → USD ⇒ USD per AUD; reciprocal gives USD→AUD
  { shortId: "aud/usd", aggregator: "0x77f9710e7d0a19669a13c055f62cd80d313df022" },
  // CAD → USD; reciprocal gives USD→CAD
  { shortId: "cad/usd", aggregator: "0xa34317db73e77d453b1b8d04550c44d10e981c8e" },
  // GBP → USD; reciprocal gives USD→GBP
  { shortId: "gbp/usd", aggregator: "0x5c0ab2d9b5a7ed9f470386e82bb36a3613cdd4b5" },
];

// ─── One-shot seeder ─────────────────────────────────────────────────────

export const addUniswapPool = internalMutation({
  args: {
    chainId: v.number(),
    version: v.union(v.literal("v2"), v.literal("v3")),
    token0: v.string(),
    token1: v.string(),
    fee: v.optional(v.number()),
    address: v.string(),
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
    const token0 = args.token0.toLowerCase();
    const token1 = args.token1.toLowerCase();
    if (token0 >= token1) {
      throw new Error(`token0 must be < token1 (got ${token0}, ${token1})`);
    }
    const address = args.address.toLowerCase();
    const existing = await ctx.db
      .query("uniswapPools")
      .withIndex("by_pair", (q) =>
        q
          .eq("networkId", network._id)
          .eq("version", args.version)
          .eq("token0", token0)
          .eq("token1", token1)
          .eq("fee", args.fee),
      )
      .unique();
    const payload = {
      networkId: network._id,
      version: args.version,
      token0,
      token1,
      fee: args.fee,
      address,
      enabled: args.enabled ?? true,
    };
    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("uniswapPools", payload);
  },
});

export const seedAll = internalMutation({
  args: {},
  handler: async (ctx): Promise<{
    networks: number;
    tokens: number;
    priceFeeds: number;
    uniswapPools: number;
  }> => {
    // Networks
    const netIds: Record<number, Id<"supportedNetworks">> = {};
    for (const n of NETWORKS) {
      const existing = await ctx.db
        .query("supportedNetworks")
        .withIndex("by_chainId", (q) => q.eq("chainId", n.chainId))
        .unique();
      const payload = {
        chainId: n.chainId,
        name: n.name,
        alchemySubdomain: n.alchemySubdomain,
        nativeSymbol: n.nativeSymbol,
        nativeDecimals: n.nativeDecimals,
        isNative: n.isNative,
        lzEndpointId: n.lzEndpointId,
        enabled: true,
      };
      if (existing) {
        await ctx.db.replace(existing._id, payload);
        netIds[n.chainId] = existing._id;
      } else {
        netIds[n.chainId] = await ctx.db.insert("supportedNetworks", payload);
      }
    }

    // Tokens — insert-only. Existing rows are left untouched so any
    // dashboard edits (renames, roundTo tweaks, …) survive a reseed.
    let tokenInserted = 0;
    for (const t of TOKENS) {
      const networkId = netIds[t.chainId];
      if (!networkId) continue;
      const addr = t.address.toLowerCase();
      const existing = await ctx.db
        .query("supportedTokens")
        .withIndex("by_networkId_and_address", (q) =>
          q.eq("networkId", networkId).eq("address", addr),
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("supportedTokens", {
        networkId,
        address: addr,
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        isNative: t.isNative,
        roundTo: t.roundTo,
        priceFeedShortId: t.priceFeedShortId,
      });
      tokenInserted += 1;
    }

    // Price feeds (all live on mainnet)
    const mainnetId = netIds[1];
    let feedCount = 0;
    if (mainnetId) {
      for (const f of PRICE_FEEDS) {
        const existing = await ctx.db
          .query("priceFeeds")
          .withIndex("by_shortId", (q) => q.eq("shortId", f.shortId))
          .unique();
        const payload = {
          shortId: f.shortId,
          networkId: mainnetId,
          aggregator: f.aggregator,
          feedDecimals: 8,
          enabled: true,
        };
        if (existing) {
          await ctx.db.replace(existing._id, payload);
        } else {
          await ctx.db.insert("priceFeeds", payload);
        }
        feedCount += 1;
      }
    }

    // Uniswap pools — upsert by (network, version, token0, token1, fee).
    let poolCount = 0;
    for (const p of POOLS) {
      const networkId = netIds[p.chainId];
      if (!networkId) continue;
      const token0 = p.token0.toLowerCase();
      const token1 = p.token1.toLowerCase();
      const existing = await ctx.db
        .query("uniswapPools")
        .withIndex("by_pair", (q) =>
          q
            .eq("networkId", networkId)
            .eq("version", p.version)
            .eq("token0", token0)
            .eq("token1", token1)
            .eq("fee", p.fee),
        )
        .unique();
      const payload = {
        networkId,
        version: p.version,
        token0,
        token1,
        fee: p.fee,
        address: p.address.toLowerCase(),
        enabled: true,
      };
      if (existing) {
        await ctx.db.replace(existing._id, payload);
      } else {
        await ctx.db.insert("uniswapPools", payload);
      }
      poolCount += 1;
    }

    return {
      networks: NETWORKS.length,
      tokens: tokenInserted,
      priceFeeds: feedCount,
      uniswapPools: poolCount,
    };
  },
});

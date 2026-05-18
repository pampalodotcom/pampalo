import { v } from "convex/values";
import { query } from "./_generated/server";

// Every supported token across all enabled networks. Used by the wallet
// dashboard so a single subscription covers the full catalogue.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const tokens = await ctx.db.query("supportedTokens").take(500);
    const networks = await ctx.db.query("supportedNetworks").take(50);
    const enabledById = new Map(
      networks.filter((n) => n.enabled).map((n) => [n._id, n]),
    );
    return tokens
      .map((t) => {
        const net = enabledById.get(t.networkId);
        if (!net) return null;
        return {
          _id: t._id,
          chainId: net.chainId,
          networkName: net.name,
          address: t.address,
          name: t.name,
          symbol: t.symbol,
          decimals: t.decimals,
          isNative: t.isNative ?? false,
          roundTo: t.roundTo,
          priceFeedShortId: t.priceFeedShortId,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  },
});

export const listForChain = query({
  args: { chainId: v.number() },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) return [];
    const tokens = await ctx.db
      .query("supportedTokens")
      .withIndex("by_networkId", (q) => q.eq("networkId", network._id))
      .take(500);
    return tokens.map((t) => ({
      _id: t._id,
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      priceFeedShortId: t.priceFeedShortId,
    }));
  },
});

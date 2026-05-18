import { v } from "convex/values";
import { query } from "./_generated/server";

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

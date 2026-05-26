import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";

// Public read-only catalog of networks. Crucially does NOT expose RPC URLs
// or the Alchemy API key — only the metadata needed for the client to
// route balance lookups through the proxy action. When BYO RPC ships, the
// client uses `chainId` here as the key to look up its own stored URL.

export const list = query({
  args: { enabledOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("supportedNetworks").take(200);
    const filtered =
      args.enabledOnly === false ? rows : rows.filter((r) => r.enabled);
    return filtered.map((r) => ({
      _id: r._id,
      chainId: r.chainId,
      name: r.name,
      nativeSymbol: r.nativeSymbol,
      nativeDecimals: r.nativeDecimals,
      isNative: r.isNative,
    }));
  },
});

// Single source of truth for "what does a proxy action need to know
// about this chain?" Returns null if the chain is unknown or disabled.
// Kept `internal` so the Alchemy subdomain doesn't leak through public
// queries. Consumed by balances/ and send/ proxy actions and by the
// price/gas refresh cron.
export const _networkForAction = internalQuery({
  args: { chainId: v.number() },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network || !network.enabled) return null;
    return {
      alchemySubdomain: network.alchemySubdomain,
      nativeSymbol: network.nativeSymbol,
      nativeDecimals: network.nativeDecimals,
      isNative: network.isNative,
    };
  },
});

export type NetworkForAction = {
  alchemySubdomain: string;
  nativeSymbol: string;
  nativeDecimals: number;
  isNative: boolean;
};

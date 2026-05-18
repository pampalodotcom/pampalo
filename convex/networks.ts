import { v } from "convex/values";
import { query } from "./_generated/server";

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

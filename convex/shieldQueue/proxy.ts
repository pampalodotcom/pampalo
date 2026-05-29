import { v } from "convex/values";
import { Interface } from "ethers";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { alchemyUrl, rpc } from "../lib/alchemy";

// Thin atomic eth_call proxy for Pampalo's `shieldBudget(address)`
// view function. Same leak profile as the existing balance / nonce
// proxies — server sees `(chainId, user address)` only — so it fits
// the ADR 0004 stance on permitted server-side reads.
//
// Returns BigInts as decimal strings so the client can round-trip them
// through Convex's V8 runtime without the JS Number 2^53 truncation.

const PAMPALO_BUDGET_IFACE = new Interface([
  "function shieldBudget(address user) view returns (uint256 effectiveCapUsdCents, uint256 usdCentsUsedThisMonth, uint256 remainingUsdCents)",
]);

export type ShieldBudgetResult = {
  effectiveCapUsdCents: string;
  usdCentsUsedThisMonth: string;
  remainingUsdCents: string;
};

export const shieldBudget = action({
  args: {
    chainId: v.number(),
    user: v.string(), // 0x… EVM address; any case accepted
  },
  handler: async (ctx, args): Promise<ShieldBudgetResult | null> => {
    const dep = await ctx.runQuery(
      internal.shieldQueue.store._deploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep) return null;

    const data = PAMPALO_BUDGET_IFACE.encodeFunctionData("shieldBudget", [
      args.user,
    ]);
    const url = alchemyUrl(dep.alchemySubdomain);
    const result = await rpc<string>(url, "eth_call", [
      { to: dep.pampalo, data },
      "latest",
    ]);

    const decoded = PAMPALO_BUDGET_IFACE.decodeFunctionResult(
      "shieldBudget",
      result,
    ) as unknown as [bigint, bigint, bigint];
    return {
      effectiveCapUsdCents: decoded[0].toString(),
      usdCentsUsedThisMonth: decoded[1].toString(),
      remainingUsdCents: decoded[2].toString(),
    };
  },
});

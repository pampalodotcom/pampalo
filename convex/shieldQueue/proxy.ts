import { v } from "convex/values";
import { id as ethersId, Interface } from "ethers";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { alchemyUrl, rpc, rpcBatch, type RpcRequest } from "../lib/alchemy";

// Thin atomic eth_call proxy for Pampalo's `shieldBudget(address)`
// view function. Same leak profile as the existing balance / nonce
// proxies — server sees `(chainId, user address)` only — so it fits
// the ADR 0004 stance on permitted server-side reads.
//
// Returns BigInts as decimal strings so the client can round-trip them
// through Convex's V8 runtime without the JS Number 2^53 truncation.

const PAMPALO_BUDGET_IFACE = new Interface([
  "function shieldBudget(address user) view returns (uint256 effectiveCapUsdCents, uint256 usdCentsUsedThisMonth, uint256 remainingUsdCents)",
  "function unshieldBudget(address user) view returns (uint256 effectiveCapUsdCents, uint256 usdCentsUsedThisMonth, uint256 remainingUsdCents)",
]);

export type BudgetResult = {
  effectiveCapUsdCents: string;
  usdCentsUsedThisMonth: string;
  remainingUsdCents: string;
};
// Retained alias — `shieldBudget`'s existing consumers import this name.
export type ShieldBudgetResult = BudgetResult;

export const shieldBudget = action({
  args: {
    chainId: v.number(),
    user: v.string(), // 0x… EVM address; any case accepted
  },
  handler: async (ctx, args): Promise<BudgetResult | null> => {
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

// Unshield twin of {shieldBudget}. Same return triple, read from the
// contract's independent `unshieldUsage` bucket — a user can have spent
// their shield budget but still hold full unshield budget, and vice versa.
// Backs the /account monthly-cap tracker (the "Unshielded this month" bar).
export const unshieldBudget = action({
  args: {
    chainId: v.number(),
    user: v.string(), // 0x… EVM address; any case accepted
  },
  handler: async (ctx, args): Promise<BudgetResult | null> => {
    const dep = await ctx.runQuery(
      internal.shieldQueue.store._deploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep) return null;

    const data = PAMPALO_BUDGET_IFACE.encodeFunctionData("unshieldBudget", [
      args.user,
    ]);
    const url = alchemyUrl(dep.alchemySubdomain);
    const result = await rpc<string>(url, "eth_call", [
      { to: dep.pampalo, data },
      "latest",
    ]);

    const decoded = PAMPALO_BUDGET_IFACE.decodeFunctionResult(
      "unshieldBudget",
      result,
    ) as unknown as [bigint, bigint, bigint];
    return {
      effectiveCapUsdCents: decoded[0].toString(),
      usdCentsUsedThisMonth: decoded[1].toString(),
      remainingUsdCents: decoded[2].toString(),
    };
  },
});

// ─── Role membership reads ───────────────────────────────────────────────
//
// The sentry UI hides Contest / Fast-track buttons for wallets that
// don't hold the relevant role, as convenience — the contract is the
// real enforcement boundary. Each call returns booleans for both roles
// for a given (chainId, user); we batch the two `hasRole` eth_calls
// into a single JSON-RPC round-trip to Alchemy. Per SHIELD_FLOW.md §10.4
// this is (B), the per-deployment on-demand path. (C) — indexing
// RoleGranted / RoleRevoked into a `pampaloRoles` table — is the
// follow-up that removes the per-user RPC entirely.

const PAMPALO_ROLES_IFACE = new Interface([
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

// keccak256 of the role strings, computed once at module load. Matches
// the on-chain `bytes32 public constant *_ROLE = keccak256("...")`
// declarations in Pampalo.sol.
const VIGILANT_CITIZEN_ROLE = ethersId("VIGILANT_CITIZEN_ROLE");
const BOOTH_OPERATOR_ROLE = ethersId("BOOTH_OPERATOR_ROLE");

export type HasRolesResult = {
  vigilantCitizen: boolean;
  boothOperator: boolean;
};

export const hasRoles = action({
  args: {
    chainId: v.number(),
    user: v.string(), // 0x… EVM address; any case accepted
  },
  handler: async (ctx, args): Promise<HasRolesResult | null> => {
    const dep = await ctx.runQuery(
      internal.shieldQueue.store._deploymentForChain,
      { chainId: args.chainId },
    );
    if (!dep) return null;

    const callVc = PAMPALO_ROLES_IFACE.encodeFunctionData("hasRole", [
      VIGILANT_CITIZEN_ROLE,
      args.user,
    ]);
    const callBo = PAMPALO_ROLES_IFACE.encodeFunctionData("hasRole", [
      BOOTH_OPERATOR_ROLE,
      args.user,
    ]);

    const url = alchemyUrl(dep.alchemySubdomain);
    const batch: Array<RpcRequest> = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "eth_call",
        params: [{ to: dep.pampalo, data: callVc }, "latest"],
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: dep.pampalo, data: callBo }, "latest"],
      },
    ];
    const responses = await rpcBatch<string>(url, batch);

    const decode = (hex: string | undefined): boolean => {
      if (!hex) return false;
      const decoded = PAMPALO_ROLES_IFACE.decodeFunctionResult(
        "hasRole",
        hex,
      ) as unknown as [boolean];
      return decoded[0];
    };

    const vcResp = responses.find((r) => r.id === 0);
    const boResp = responses.find((r) => r.id === 1);
    return {
      vigilantCitizen: !vcResp?.error && decode(vcResp?.result),
      boothOperator: !boResp?.error && decode(boResp?.result),
    };
  },
});

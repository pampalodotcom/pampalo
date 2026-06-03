import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { alchemyUrl, rpc } from "../lib/alchemy";
import { leftPad32, normalizeAddress } from "../lib/evm";
import type { NetworkForAction } from "../catalog/networks";
import type { NativeBalanceResult, TokenBalanceResult } from "./types";

// Stateless RPC proxies for dashboard balance reads. The server holds the
// Alchemy API key; the client supplies `(chainId, address)`. NOTHING is
// written to the database. See ADR 0004 for the broader send/balances
// posture and `_networkForAction` in `catalog/networks.ts` for the
// chain-config lookup these calls funnel through.

const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

// ─── Native (ETH or chain-native) balance ────────────────────────────────

export const getNativeBalance = action({
  args: {
    chainId: v.number(),
    address: v.string(),
  },
  handler: async (ctx, args): Promise<NativeBalanceResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.catalog.networks._networkForAction,
      { chainId: args.chainId },
    );
    if (!network)
      throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    const url = alchemyUrl(network.alchemySubdomain);
    const addr = normalizeAddress(args.address);
    const balanceHex: string = await rpc(url, "eth_getBalance", [
      addr,
      "latest",
    ]);
    return {
      chainId: args.chainId,
      address: addr,
      balanceWei: BigInt(balanceHex).toString(),
      decimals: network.nativeDecimals,
      symbol: network.nativeSymbol,
      isNative: network.isNative,
      fetchedAt: Date.now(),
    };
  },
});

// ─── ERC20 token balance ─────────────────────────────────────────────────

export const getTokenBalance = action({
  args: {
    chainId: v.number(),
    address: v.string(), // user's EVM address
    tokenAddress: v.string(),
    decimals: v.number(),
    symbol: v.string(),
  },
  handler: async (ctx, args): Promise<TokenBalanceResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.catalog.networks._networkForAction,
      { chainId: args.chainId },
    );
    if (!network)
      throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    const url = alchemyUrl(network.alchemySubdomain);
    const user = normalizeAddress(args.address);
    const token = normalizeAddress(args.tokenAddress);
    const data = ERC20_BALANCE_OF_SELECTOR + leftPad32(user.slice(2));
    const resultHex: string = await rpc(url, "eth_call", [
      { to: token, data },
      "latest",
    ]);
    return {
      chainId: args.chainId,
      address: user,
      tokenAddress: token,
      balanceWei: BigInt(resultHex).toString(),
      decimals: args.decimals,
      symbol: args.symbol,
      fetchedAt: Date.now(),
    };
  },
});

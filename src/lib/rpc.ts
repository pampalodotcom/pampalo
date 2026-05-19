import { useMemo } from "react";
import { useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";

// Single source of truth for "how do I read on-chain state for this user?"
// All call sites depend on RpcClient — never on Convex actions or fetch
// directly — so swapping in a user-supplied RPC URL later is mechanical.

export type NativeBalance = {
  chainId: number;
  address: string;
  balanceWei: string;
  decimals: number;
  symbol: string;
  isNative: boolean;
  fetchedAt: number;
};

export type TokenBalance = {
  chainId: number;
  address: string;
  tokenAddress: string;
  balanceWei: string;
  decimals: number;
  symbol: string;
  fetchedAt: number;
};

export type TokenRef = {
  chainId: number;
  tokenAddress: string;
  decimals: number;
  symbol: string;
};

export interface RpcClient {
  /** Source of this client: 'proxy' when calls go through the Convex
   *  action, 'direct' when calls go straight to the user's RPC URL. */
  readonly source: "proxy" | "direct";

  getNativeBalance: (chainId: number, address: string) => Promise<NativeBalance>;
  getTokenBalance: (token: TokenRef, address: string) => Promise<TokenBalance>;
}

// ─── Proxy client (current default) ──────────────────────────────────────
// Goes through the stateless `rpcProxy` Convex action so the Alchemy API
// key stays server-side. The server sees (address, chainId) in transit
// but never persists anything.

type ConvexClient = ReturnType<typeof useConvex>;

class ProxiedRpcClient implements RpcClient {
  readonly source = "proxy" as const;

  constructor(private readonly convex: ConvexClient) {}

  getNativeBalance(chainId: number, address: string): Promise<NativeBalance> {
    return this.convex.action(api.rpcProxy.getNativeBalance, {
      chainId,
      address,
    });
  }

  getTokenBalance(token: TokenRef, address: string): Promise<TokenBalance> {
    return this.convex.action(api.rpcProxy.getTokenBalance, {
      chainId: token.chainId,
      address,
      tokenAddress: token.tokenAddress,
      decimals: token.decimals,
      symbol: token.symbol,
    });
  }
}

// ─── Direct client (BYO-RPC future) ──────────────────────────────────────
// Placeholder kept here so the migration is just "wire this up + change
// the factory". The encoding/decoding logic mirrors what convex/rpcProxy.ts
// does so behaviour is identical.

const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

function normalizeAddress(addr: string): string {
  const a = addr.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    throw new Error(`Invalid address: ${addr}`);
  }
  return a;
}

function leftPad32(hexNo0x: string): string {
  if (hexNo0x.length > 64) throw new Error("address pad overflow");
  return "0".repeat(64 - hexNo0x.length) + hexNo0x;
}

async function jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  if (body.result === undefined) throw new Error("RPC returned no result");
  return body.result;
}

export type DirectRpcConfig = {
  chainId: number;
  url: string;
  nativeSymbol: string;
  nativeDecimals: number;
  isNative: boolean;
};

export class DirectRpcClient implements RpcClient {
  readonly source = "direct" as const;

  /** Per-chain config — typically loaded from localStorage when BYO-RPC
   *  is enabled. Pass one entry per chain the user expects to hit. */
  constructor(private readonly configs: Map<number, DirectRpcConfig>) {}

  private cfg(chainId: number): DirectRpcConfig {
    const c = this.configs.get(chainId);
    if (!c) throw new Error(`No BYO RPC configured for chainId ${chainId}`);
    return c;
  }

  async getNativeBalance(chainId: number, address: string): Promise<NativeBalance> {
    const c = this.cfg(chainId);
    const addr = normalizeAddress(address);
    const balanceHex = await jsonRpc<string>(c.url, "eth_getBalance", [addr, "latest"]);
    return {
      chainId,
      address: addr,
      balanceWei: BigInt(balanceHex).toString(),
      decimals: c.nativeDecimals,
      symbol: c.nativeSymbol,
      isNative: c.isNative,
      fetchedAt: Date.now(),
    };
  }

  async getTokenBalance(token: TokenRef, address: string): Promise<TokenBalance> {
    const c = this.cfg(token.chainId);
    const user = normalizeAddress(address);
    const tok = normalizeAddress(token.tokenAddress);
    const data = ERC20_BALANCE_OF_SELECTOR + leftPad32(user.slice(2));
    const hex = await jsonRpc<string>(c.url, "eth_call", [
      { to: tok, data },
      "latest",
    ]);
    return {
      chainId: token.chainId,
      address: user,
      tokenAddress: tok,
      balanceWei: BigInt(hex).toString(),
      decimals: token.decimals,
      symbol: token.symbol,
      fetchedAt: Date.now(),
    };
  }
}

// ─── React hook factory ──────────────────────────────────────────────────
// Single place that decides which implementation to hand out. When BYO
// RPC ships, read user-configured URLs from localStorage here and return
// a DirectRpcClient when one exists for the requested chain.

export function useRpcClient(): RpcClient {
  const convex = useConvex();
  return useMemo(() => new ProxiedRpcClient(convex), [convex]);
}

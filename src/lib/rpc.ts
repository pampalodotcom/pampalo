import { useMemo } from "react";
import { useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import { getSessionToken } from "./keystore";

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

export type Nonce = {
  chainId: number;
  address: string;
  /** Decimal string. "pending"-tagged so consecutive sends don't collide. */
  nonce: string;
  fetchedAt: number;
};

export type BroadcastResult = {
  chainId: number;
  txHash: string;
};

/** What the gas-sponsoring relayer can be asked to broadcast. */
export type RelayKind = "transfer" | "unshield" | "swap";

/** Mirror of `api.relayer.node.relay`'s discriminated return. The client
 *  switches on `reason` to decide: surface (WOULD_REVERT/BAD_PROOF) or
 *  offer self-broadcast fallback (POOL_EXHAUSTED/CHAIN_NOT_SPONSORED). */
export type RelayResult =
  | { ok: true; chainId: number; txHash: string }
  | { ok: false; reason: "WOULD_REVERT"; revertReason: string }
  | { ok: false; reason: "POOL_EXHAUSTED" }
  | { ok: false; reason: "CHAIN_NOT_SPONSORED" }
  | { ok: false; reason: "BAD_PROOF" }
  | { ok: false; reason: "UNKNOWN"; message: string };

export type TxStatus = {
  chainId: number;
  txHash: string;
  /** null while the receipt isn't available yet. */
  blockNumber: number | null;
  /** null = pending; true = success; false = reverted. */
  status: boolean | null;
  /** Latest block on the chain at fetch time. */
  currentBlock: number;
  /** currentBlock − blockNumber + 1; 0 while pending. */
  confirmations: number;
  fetchedAt: number;
};

export interface RpcClient {
  /** Source of this client: 'proxy' when calls go through the Convex
   *  action, 'direct' when calls go straight to the user's RPC URL. */
  readonly source: "proxy" | "direct";

  getNativeBalance: (
    chainId: number,
    address: string,
  ) => Promise<NativeBalance>;
  getTokenBalance: (token: TokenRef, address: string) => Promise<TokenBalance>;

  // Send-flow methods. Per ADR 0004 each is atomic and leaks no more
  // than the balance methods above.
  getNonce: (chainId: number, address: string) => Promise<Nonce>;
  sendRawTransaction: (
    chainId: number,
    rawTx: string,
  ) => Promise<BroadcastResult>;
  getTransactionStatus: (chainId: number, txHash: string) => Promise<TxStatus>;

  /** Ask Pampalo's gas-sponsoring relayer to broadcast a transfer/unshield
   *  so the user's EVM address never signs it. Convex-gated: a `direct`
   *  (BYO-RPC) client has no pool and returns CHAIN_NOT_SPONSORED, so the
   *  caller self-broadcasts. The relayer verifies the proof via simulation
   *  before spending gas. See ADR 0015 / TRANSFERS.md §3. */
  relay: (req: {
    chainId: number;
    kind: RelayKind;
    proof: string;
    publicInputs: readonly string[];
    /** transfer/swap: ECIES NotePayload ciphertexts (0..3). */
    payload?: readonly string[];
    /** swap only: the opaque Uniswap route bytes. */
    route?: string;
  }) => Promise<RelayResult>;
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
    return this.convex.action(api.balances.proxy.getNativeBalance, {
      chainId,
      address,
    });
  }

  getTokenBalance(token: TokenRef, address: string): Promise<TokenBalance> {
    return this.convex.action(api.balances.proxy.getTokenBalance, {
      chainId: token.chainId,
      address,
      tokenAddress: token.tokenAddress,
      decimals: token.decimals,
      symbol: token.symbol,
    });
  }

  getNonce(chainId: number, address: string): Promise<Nonce> {
    return this.convex.action(api.send.proxy.getNonce, { chainId, address });
  }

  sendRawTransaction(chainId: number, rawTx: string): Promise<BroadcastResult> {
    return this.convex.action(api.send.proxy.sendRawTransaction, {
      chainId,
      rawTx,
    });
  }

  getTransactionStatus(chainId: number, txHash: string): Promise<TxStatus> {
    return this.convex.action(api.send.proxy.getTransactionStatus, {
      chainId,
      txHash,
    });
  }

  relay(req: {
    chainId: number;
    kind: RelayKind;
    proof: string;
    publicInputs: readonly string[];
    payload?: readonly string[];
    route?: string;
  }): Promise<RelayResult> {
    const sessionToken = getSessionToken();
    if (!sessionToken) {
      // No session → can't authenticate to the relayer. Treat as "not
      // sponsored" so the caller self-broadcasts rather than hard-failing.
      return Promise.resolve({
        ok: false,
        reason: "CHAIN_NOT_SPONSORED",
      } as RelayResult);
    }
    return this.convex.action(api.relayer.node.relay, {
      sessionToken,
      chainId: req.chainId,
      kind: req.kind,
      proof: req.proof,
      publicInputs: [...req.publicInputs],
      payload: req.payload ? [...req.payload] : undefined,
      route: req.route,
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

async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
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
  if (body.error)
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
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

  async getNativeBalance(
    chainId: number,
    address: string,
  ): Promise<NativeBalance> {
    const c = this.cfg(chainId);
    const addr = normalizeAddress(address);
    const balanceHex = await jsonRpc<string>(c.url, "eth_getBalance", [
      addr,
      "latest",
    ]);
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

  async getTokenBalance(
    token: TokenRef,
    address: string,
  ): Promise<TokenBalance> {
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

  async getNonce(chainId: number, address: string): Promise<Nonce> {
    const c = this.cfg(chainId);
    const addr = normalizeAddress(address);
    const nonceHex = await jsonRpc<string>(c.url, "eth_getTransactionCount", [
      addr,
      "pending",
    ]);
    return {
      chainId,
      address: addr,
      nonce: BigInt(nonceHex).toString(),
      fetchedAt: Date.now(),
    };
  }

  async sendRawTransaction(
    chainId: number,
    rawTx: string,
  ): Promise<BroadcastResult> {
    const c = this.cfg(chainId);
    if (!/^0x[0-9a-fA-F]+$/.test(rawTx)) {
      throw new Error("rawTx must be 0x-prefixed hex");
    }
    const txHash = await jsonRpc<string>(c.url, "eth_sendRawTransaction", [
      rawTx,
    ]);
    return { chainId, txHash };
  }

  async getTransactionStatus(
    chainId: number,
    txHash: string,
  ): Promise<TxStatus> {
    const c = this.cfg(chainId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error(`Invalid txHash: ${txHash}`);
    }
    type Receipt = { blockNumber: string; status: string } | null;
    const [receipt, blockHex] = await Promise.all([
      jsonRpc<Receipt>(c.url, "eth_getTransactionReceipt", [txHash]),
      jsonRpc<string>(c.url, "eth_blockNumber", []),
    ]);
    const currentBlock = Number(BigInt(blockHex));
    let blockNumber: number | null = null;
    let status: boolean | null = null;
    let confirmations = 0;
    if (receipt) {
      blockNumber = Number(BigInt(receipt.blockNumber));
      status = receipt.status === "0x1";
      confirmations = Math.max(0, currentBlock - blockNumber + 1);
    }
    return {
      chainId,
      txHash,
      blockNumber,
      status,
      currentBlock,
      confirmations,
      fetchedAt: Date.now(),
    };
  }

  // BYO-RPC mode has no Pampalo relayer pool — the user signs and
  // broadcasts from their own wallet. Report "not sponsored" so callers
  // take the self-broadcast path.
  relay(): Promise<RelayResult> {
    return Promise.resolve({
      ok: false,
      reason: "CHAIN_NOT_SPONSORED",
    } as RelayResult);
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

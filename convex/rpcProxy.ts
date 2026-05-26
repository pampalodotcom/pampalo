import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";

// Stateless RPC proxy for user balance lookups. The server holds the
// Alchemy API key; the client supplies (address, chainId). NOTHING is
// written to the database.
//
// When BYO-RPC ships, the client skips this entirely and calls the user's
// URL directly. Both code paths return identical shapes so swapping the
// client-side `RpcClient` is enough.

const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

function alchemyUrl(subdomain: string): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY not set in Convex environment.");
  return `https://${subdomain}.g.alchemy.com/v2/${key}`;
}

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

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error) {
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error("RPC returned no result");
  }
  return body.result;
}

// Single source of truth for "what does the action need to know about
// this chain?" Returns null if the chain is unknown or disabled. Kept
// `internal` so the Alchemy subdomain doesn't leak through public queries.
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

type NetworkForAction = {
  alchemySubdomain: string;
  nativeSymbol: string;
  nativeDecimals: number;
  isNative: boolean;
};

// ─── Native (ETH or chain-native) balance ────────────────────────────────

export type NativeBalanceResult = {
  chainId: number;
  address: string;
  balanceWei: string;
  decimals: number;
  symbol: string;
  isNative: boolean;
  fetchedAt: number;
};

export const getNativeBalance = action({
  args: {
    chainId: v.number(),
    address: v.string(),
  },
  handler: async (ctx, args): Promise<NativeBalanceResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.rpcProxy._networkForAction,
      { chainId: args.chainId },
    );
    if (!network) throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    const url = alchemyUrl(network.alchemySubdomain);
    const addr = normalizeAddress(args.address);
    const balanceHex: string = await rpc(url, "eth_getBalance", [addr, "latest"]);
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

export type TokenBalanceResult = {
  chainId: number;
  address: string;
  tokenAddress: string;
  balanceWei: string;
  decimals: number;
  symbol: string;
  fetchedAt: number;
};

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
      internal.rpcProxy._networkForAction,
      { chainId: args.chainId },
    );
    if (!network) throw new Error(`Unknown or disabled chainId ${args.chainId}`);
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

// ─── Send-flow helpers ──────────────────────────────────────────────────
// Three thin passthroughs that keep the Alchemy key server-side while the
// client owns transaction construction + signing. Per ADR 0004 each one
// is atomic and leaks no more than the existing balance proxies:
//
//   getNonce             — pending nonce for an address. Same leak as
//                          `getNativeBalance` (chainId + address).
//   sendRawTransaction   — broadcast a hex-encoded signed transaction.
//                          The signed tx is necessarily public at the
//                          moment it broadcasts.
//   getTransactionStatus — receipt + current block, used by the post-send
//                          tracking UI to compute confirmations without
//                          paying the RPC cost from the client. txHash
//                          is public on-chain.
//
// Gas pricing is intentionally NOT a server action — the client reads
// the latestGas cron query and applies a tier multiplier. eth_estimateGas
// is intentionally NOT exposed — the client uses fallback constants
// (21k native / 65k ERC20 × 1.2). See ADR 0004.

export type NonceResult = {
  chainId: number;
  address: string;
  /** Decimal string; "pending" tag includes any in-flight tx the user
   *  has already broadcast, so two sends in quick succession get
   *  monotonically increasing nonces without a stuck-tx collision. */
  nonce: string;
  fetchedAt: number;
};

export const getNonce = action({
  args: {
    chainId: v.number(),
    address: v.string(),
  },
  handler: async (ctx, args): Promise<NonceResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.rpcProxy._networkForAction,
      { chainId: args.chainId },
    );
    if (!network) throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    const url = alchemyUrl(network.alchemySubdomain);
    const addr = normalizeAddress(args.address);
    const nonceHex: string = await rpc(url, "eth_getTransactionCount", [
      addr,
      "pending",
    ]);
    return {
      chainId: args.chainId,
      address: addr,
      nonce: BigInt(nonceHex).toString(),
      fetchedAt: Date.now(),
    };
  },
});

export type SendRawTransactionResult = {
  chainId: number;
  txHash: string;
};

export const sendRawTransaction = action({
  args: {
    chainId: v.number(),
    /** 0x-prefixed RLP-encoded signed transaction. */
    rawTx: v.string(),
  },
  handler: async (ctx, args): Promise<SendRawTransactionResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.rpcProxy._networkForAction,
      { chainId: args.chainId },
    );
    if (!network) throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    if (!/^0x[0-9a-fA-F]+$/.test(args.rawTx)) {
      throw new Error("rawTx must be 0x-prefixed hex");
    }
    const url = alchemyUrl(network.alchemySubdomain);
    const txHash = await rpc<string>(url, "eth_sendRawTransaction", [
      args.rawTx,
    ]);
    return { chainId: args.chainId, txHash };
  },
});

export type TransactionStatusResult = {
  chainId: number;
  txHash: string;
  /** null when the transaction isn't mined yet. */
  blockNumber: number | null;
  /** null = pending. true = success. false = reverted. */
  status: boolean | null;
  /** Latest block on the chain. Used for confirmation count math. */
  currentBlock: number;
  /** Best-effort confirmations count (currentBlock - blockNumber + 1).
   *  0 while pending. */
  confirmations: number;
  fetchedAt: number;
};

export const getTransactionStatus = action({
  args: {
    chainId: v.number(),
    txHash: v.string(),
  },
  handler: async (ctx, args): Promise<TransactionStatusResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.rpcProxy._networkForAction,
      { chainId: args.chainId },
    );
    if (!network) throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) {
      throw new Error(`Invalid txHash: ${args.txHash}`);
    }
    const url = alchemyUrl(network.alchemySubdomain);

    // Receipt + current head in parallel.
    type Receipt = {
      blockNumber: string;
      status: string;
    } | null;
    const [receipt, blockHex] = await Promise.all([
      rpc<Receipt>(url, "eth_getTransactionReceipt", [args.txHash]),
      rpc<string>(url, "eth_blockNumber", []),
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
      chainId: args.chainId,
      txHash: args.txHash,
      blockNumber,
      status,
      currentBlock,
      confirmations,
      fetchedAt: Date.now(),
    };
  },
});

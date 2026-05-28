import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { alchemyUrl, rpc } from "../lib/alchemy";
import { normalizeAddress } from "../lib/evm";
import type { NetworkForAction } from "../catalog/networks";
import type {
  NonceResult,
  SendRawTransactionResult,
  TransactionStatusResult,
} from "./types";

// Send-flow RPC proxies. Per ADR 0004 each one is atomic and leaks no
// more than the existing balance proxies:
//
//   getNonce             — pending nonce for an address. Same leak as
//                          `balances.proxy.getNativeBalance`.
//   sendRawTransaction   — broadcast a hex-encoded signed transaction.
//                          The signed tx is necessarily public at the
//                          moment it broadcasts.
//   getTransactionStatus — receipt + current block, used by the post-send
//                          tracking UI to compute confirmations. txHash
//                          is public on-chain.
//
// Gas pricing is intentionally NOT a server action — the client reads
// the latestGas cron query and applies a tier multiplier. eth_estimateGas
// is intentionally NOT exposed — the client uses fallback constants
// (21k native / 65k ERC20 × 1.2). See ADR 0004.

// ─── Nonce ──────────────────────────────────────────────────────────────

export const getNonce = action({
  args: {
    chainId: v.number(),
    address: v.string(),
  },
  handler: async (ctx, args): Promise<NonceResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.catalog.networks._networkForAction,
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

// ─── Broadcast ──────────────────────────────────────────────────────────

export const sendRawTransaction = action({
  args: {
    chainId: v.number(),
    /** 0x-prefixed RLP-encoded signed transaction. */
    rawTx: v.string(),
  },
  handler: async (ctx, args): Promise<SendRawTransactionResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.catalog.networks._networkForAction,
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

// ─── Status polling ─────────────────────────────────────────────────────

export const getTransactionStatus = action({
  args: {
    chainId: v.number(),
    txHash: v.string(),
  },
  handler: async (ctx, args): Promise<TransactionStatusResult> => {
    const network: NetworkForAction | null = await ctx.runQuery(
      internal.catalog.networks._networkForAction,
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

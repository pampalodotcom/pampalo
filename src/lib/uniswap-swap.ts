import { Interface } from "ethers";

// Builds raw transaction calldata for Uniswap V2 (Router02) and V3
// (SwapRouter02) swaps. Pure — no RPC, no Convex. Takes a quote from
// the `getQuote` action plus user-side params (recipient, slippage,
// deadline) and returns `{to, data, value}` the wallet can sign.
//
// Address book is duplicated from convex/uniswap.ts because:
//   1. The client can't import from convex/* without dragging in
//      convex/server in some bundler configs, and
//   2. The two paths (server quoting + client signing) genuinely care
//      about *different* router contracts — keeping the constants
//      collocated with their consumer beats one shared file.

// ─── Address book ───────────────────────────────────────────────────────

type ChainAddresses = {
  v2Router02: string;
  v3SwapRouter02: string;
  weth: string;
};

export const UNISWAP_CLIENT_ADDRESSES: Partial<Record<number, ChainAddresses>> =
  {
    1: {
      v2Router02: "0x7a250d5630B4cF539739dF2C5dacb4c659F2488D",
      v3SwapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
    8453: {
      v2Router02: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      v3SwapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
      weth: "0x4200000000000000000000000000000000000006",
    },
  };

// Re-exported under the historical name to avoid churning the uniswap
// test fixtures. New code should `import { ETH_SENTINEL } from "./eth"`.
import { ETH_SENTINEL } from "./eth";
export { ETH_SENTINEL };

// SwapRouter02 uses constants for the "send to router" recipient so
// the next call in a multicall can sweep / unwrap. The router
// resolves address(2) to itself.
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

// ─── Interfaces ─────────────────────────────────────────────────────────

const V2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
];

const V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
];

const v2Iface = new Interface(V2_ROUTER_ABI);
const v3Iface = new Interface(V3_ROUTER_ABI);

// ─── Types ──────────────────────────────────────────────────────────────

export type SwapTx = {
  to: string;
  data: string;
  value: string; // decimal wei
};

export type SwapKind = "exactIn" | "exactOut";

export type V2SwapParams = {
  chainId: number;
  kind: SwapKind;
  tokenIn: string; // may be ETH_SENTINEL
  tokenOut: string; // may be ETH_SENTINEL
  // The exact side: amountIn for exactIn, amountOut for exactOut.
  amount: bigint;
  // The slippage-protected side: amountOutMin (exactIn) or amountInMax (exactOut).
  amountLimit: bigint;
  recipient: string;
  deadlineSeconds: number; // unix timestamp
};

export type V3SwapParams = {
  chainId: number;
  kind: SwapKind;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amount: bigint;
  amountLimit: bigint;
  recipient: string;
  /** If set, wraps in multicall(deadline, [...]) so the router enforces it. */
  deadlineSeconds?: number;
  /** 0n means "no limit"; this is the safe default. */
  sqrtPriceLimitX96?: bigint;
};

// ─── V2 ─────────────────────────────────────────────────────────────────

export function buildV2SwapTx(p: V2SwapParams): SwapTx {
  const book = UNISWAP_CLIENT_ADDRESSES[p.chainId];
  if (!book) throw new Error(`No Uniswap router for chainId ${p.chainId}`);
  const tokenInIsEth = p.tokenIn.toLowerCase() === ETH_SENTINEL;
  const tokenOutIsEth = p.tokenOut.toLowerCase() === ETH_SENTINEL;
  if (tokenInIsEth && tokenOutIsEth) {
    throw new Error("Both sides cannot be ETH");
  }

  // Path is in real token addresses (WETH substituted for the ETH side).
  const pathIn = tokenInIsEth ? book.weth : p.tokenIn;
  const pathOut = tokenOutIsEth ? book.weth : p.tokenOut;
  const path = [pathIn, pathOut];

  // Six functions covering {exactIn, exactOut} × {token→token, ETH→token, token→ETH}.
  let data: string;
  let value = 0n;
  if (p.kind === "exactIn") {
    if (tokenInIsEth) {
      data = v2Iface.encodeFunctionData("swapExactETHForTokens", [
        p.amountLimit, // amountOutMin
        path,
        p.recipient,
        BigInt(p.deadlineSeconds),
      ]);
      value = p.amount;
    } else if (tokenOutIsEth) {
      data = v2Iface.encodeFunctionData("swapExactTokensForETH", [
        p.amount,
        p.amountLimit,
        path,
        p.recipient,
        BigInt(p.deadlineSeconds),
      ]);
    } else {
      data = v2Iface.encodeFunctionData("swapExactTokensForTokens", [
        p.amount,
        p.amountLimit,
        path,
        p.recipient,
        BigInt(p.deadlineSeconds),
      ]);
    }
  } else {
    if (tokenInIsEth) {
      // amountInMax is amountLimit; user sends amountInMax as value
      // and the router refunds the unused ETH.
      data = v2Iface.encodeFunctionData("swapETHForExactTokens", [
        p.amount, // amountOut
        path,
        p.recipient,
        BigInt(p.deadlineSeconds),
      ]);
      value = p.amountLimit;
    } else if (tokenOutIsEth) {
      data = v2Iface.encodeFunctionData("swapTokensForExactETH", [
        p.amount,
        p.amountLimit,
        path,
        p.recipient,
        BigInt(p.deadlineSeconds),
      ]);
    } else {
      data = v2Iface.encodeFunctionData("swapTokensForExactTokens", [
        p.amount,
        p.amountLimit,
        path,
        p.recipient,
        BigInt(p.deadlineSeconds),
      ]);
    }
  }

  return { to: book.v2Router02, data, value: value.toString() };
}

// ─── V3 ─────────────────────────────────────────────────────────────────

// SwapRouter02 has no per-call deadline; if the user wants one, we
// wrap in multicall(uint256 deadline, bytes[] data). ETH-out swaps
// always go through multicall because they need a follow-up
// unwrapWETH9 after the swap.
export function buildV3SwapTx(p: V3SwapParams): SwapTx {
  const book = UNISWAP_CLIENT_ADDRESSES[p.chainId];
  if (!book) throw new Error(`No Uniswap router for chainId ${p.chainId}`);
  const tokenInIsEth = p.tokenIn.toLowerCase() === ETH_SENTINEL;
  const tokenOutIsEth = p.tokenOut.toLowerCase() === ETH_SENTINEL;
  if (tokenInIsEth && tokenOutIsEth) {
    throw new Error("Both sides cannot be ETH");
  }
  const tokenIn = tokenInIsEth ? book.weth : p.tokenIn;
  const tokenOut = tokenOutIsEth ? book.weth : p.tokenOut;

  // When ETH is on the output side, the swap routes to address(2)
  // (the router) and we follow with unwrapWETH9. Otherwise the
  // swap goes straight to the user.
  const swapRecipient = tokenOutIsEth ? ADDRESS_THIS : p.recipient;

  const sqrtLimit = p.sqrtPriceLimitX96 ?? 0n;

  let swapCalldata: string;
  let value = 0n;
  if (p.kind === "exactIn") {
    swapCalldata = v3Iface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn,
        tokenOut,
        fee: p.fee,
        recipient: swapRecipient,
        amountIn: p.amount,
        amountOutMinimum: p.amountLimit,
        sqrtPriceLimitX96: sqrtLimit,
      },
    ]);
    if (tokenInIsEth) value = p.amount;
  } else {
    swapCalldata = v3Iface.encodeFunctionData("exactOutputSingle", [
      {
        tokenIn,
        tokenOut,
        fee: p.fee,
        recipient: swapRecipient,
        amountOut: p.amount,
        amountInMaximum: p.amountLimit,
        sqrtPriceLimitX96: sqrtLimit,
      },
    ]);
    if (tokenInIsEth) value = p.amountLimit; // up to amountInMax; refundETH below recovers the rest
  }

  // Compose the multicall payload, if needed.
  const calls: string[] = [swapCalldata];
  if (tokenOutIsEth) {
    // Sweep the swapped WETH out as ETH to the user. amountMinimum
    // = amountLimit for exactIn; for exactOut we need exactly p.amount
    // ETH so 0 is fine (the swap already enforced it).
    const amountMinimum = p.kind === "exactIn" ? p.amountLimit : p.amount;
    calls.push(
      v3Iface.encodeFunctionData("unwrapWETH9", [amountMinimum, p.recipient]),
    );
  }
  if (p.kind === "exactOut" && tokenInIsEth) {
    // exactOut + ETH-in: refund leftover ETH the user sent above the
    // actual amountIn. Without this they lose the difference.
    calls.push(v3Iface.encodeFunctionData("refundETH", []));
  }

  let data: string;
  if (calls.length === 1 && p.deadlineSeconds === undefined) {
    data = calls[0];
  } else if (p.deadlineSeconds !== undefined) {
    data = v3Iface.encodeFunctionData("multicall(uint256,bytes[])", [
      BigInt(p.deadlineSeconds),
      calls,
    ]);
  } else {
    data = v3Iface.encodeFunctionData("multicall(bytes[])", [calls]);
  }

  return { to: book.v3SwapRouter02, data, value: value.toString() };
}

// ─── Slippage helpers ───────────────────────────────────────────────────
// Slippage in basis points (1 = 0.01%, 50 = 0.5%, 100 = 1%).

export function applySlippageMin(
  amountOut: bigint,
  slippageBps: number,
): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("slippageBps out of range");
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function applySlippageMax(
  amountIn: bigint,
  slippageBps: number,
): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("slippageBps out of range");
  }
  return (amountIn * BigInt(10_000 + slippageBps)) / 10_000n;
}

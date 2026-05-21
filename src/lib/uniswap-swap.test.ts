/// <reference types="vite/client" />
import { Interface } from "ethers";
import { describe, expect, test } from "vitest";
import {
  applySlippageMax,
  applySlippageMin,
  buildV2SwapTx,
  buildV3SwapTx,
  ETH_SENTINEL,
  UNISWAP_CLIENT_ADDRESSES,
} from "./uniswap-swap";

// Same ABI as in the production file — used here to decode and assert.
const v2Iface = new Interface([
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function swapTokensForExactTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
  "function swapETHForExactTokens(uint256,address[],address,uint256) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function swapTokensForExactETH(uint256,uint256,address[],address,uint256) returns (uint256[])",
]);
const v3Iface = new Interface([
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
  "function exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
  "function unwrapWETH9(uint256,address) payable",
  "function refundETH() payable",
  "function multicall(bytes[]) payable returns (bytes[])",
  "function multicall(uint256,bytes[]) payable returns (bytes[])",
]);

const RECIPIENT = "0x405338F496D665C821518107895F0b9639Fde789";
const DEADLINE = 1_900_000_000;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AUDD = "0x4cCe605eD955295432958d8951D0B176C10720d5";
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

// ─── V2 ─────────────────────────────────────────────────────────────────

describe("buildV2SwapTx", () => {
  test("exactIn token→token: swapExactTokensForTokens, value=0", () => {
    const tx = buildV2SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: USDC,
      tokenOut: AUDD,
      amount: 1_000_000n,
      amountLimit: 990_000n,
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    expect(tx.to.toLowerCase()).toBe(
      UNISWAP_CLIENT_ADDRESSES[1]!.v2Router02.toLowerCase(),
    );
    expect(tx.value).toBe("0");
    const decoded = v2Iface.decodeFunctionData("swapExactTokensForTokens", tx.data);
    expect(decoded[0]).toBe(1_000_000n);
    expect(decoded[1]).toBe(990_000n);
    expect(decoded[2].map((a: string) => a.toLowerCase())).toEqual([
      USDC.toLowerCase(),
      AUDD.toLowerCase(),
    ]);
    expect(decoded[3].toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(decoded[4]).toBe(BigInt(DEADLINE));
  });

  test("exactOut token→token: swapTokensForExactTokens", () => {
    const tx = buildV2SwapTx({
      chainId: 1,
      kind: "exactOut",
      tokenIn: USDC,
      tokenOut: AUDD,
      amount: 1_000_000n, // amountOut
      amountLimit: 1_100_000n, // amountInMax
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    expect(tx.value).toBe("0");
    const decoded = v2Iface.decodeFunctionData("swapTokensForExactTokens", tx.data);
    expect(decoded[0]).toBe(1_000_000n);
    expect(decoded[1]).toBe(1_100_000n);
  });

  test("exactIn ETH→token: swapExactETHForTokens, value=amount, path starts with WETH", () => {
    const tx = buildV2SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: ETH_SENTINEL,
      tokenOut: USDC,
      amount: 10n ** 18n,
      amountLimit: 1_900_000_000n,
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    expect(tx.value).toBe((10n ** 18n).toString());
    const decoded = v2Iface.decodeFunctionData("swapExactETHForTokens", tx.data);
    expect(decoded[0]).toBe(1_900_000_000n); // amountOutMin
    expect(decoded[1].map((a: string) => a.toLowerCase())).toEqual([
      WETH_MAINNET.toLowerCase(),
      USDC.toLowerCase(),
    ]);
  });

  test("exactIn token→ETH: swapExactTokensForETH, path ends with WETH", () => {
    const tx = buildV2SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: USDC,
      tokenOut: ETH_SENTINEL,
      amount: 1_000_000_000n,
      amountLimit: 4n * 10n ** 17n,
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    expect(tx.value).toBe("0");
    const decoded = v2Iface.decodeFunctionData("swapExactTokensForETH", tx.data);
    expect(decoded[2].map((a: string) => a.toLowerCase())).toEqual([
      USDC.toLowerCase(),
      WETH_MAINNET.toLowerCase(),
    ]);
  });

  test("exactOut ETH→token: swapETHForExactTokens, value=amountInMax", () => {
    const tx = buildV2SwapTx({
      chainId: 1,
      kind: "exactOut",
      tokenIn: ETH_SENTINEL,
      tokenOut: USDC,
      amount: 2_000_000_000n, // amountOut
      amountLimit: 11n * 10n ** 17n, // amountInMax (sent as value)
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    expect(tx.value).toBe((11n * 10n ** 17n).toString());
    const decoded = v2Iface.decodeFunctionData("swapETHForExactTokens", tx.data);
    expect(decoded[0]).toBe(2_000_000_000n);
  });

  test("Base chain uses Base router + WETH", () => {
    const tx = buildV2SwapTx({
      chainId: 8453,
      kind: "exactIn",
      tokenIn: ETH_SENTINEL,
      tokenOut: USDC,
      amount: 10n ** 18n,
      amountLimit: 1n,
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    expect(tx.to.toLowerCase()).toBe(
      UNISWAP_CLIENT_ADDRESSES[8453]!.v2Router02.toLowerCase(),
    );
    const decoded = v2Iface.decodeFunctionData("swapExactETHForTokens", tx.data);
    expect(decoded[1][0].toLowerCase()).toBe(
      UNISWAP_CLIENT_ADDRESSES[8453]!.weth.toLowerCase(),
    );
  });

  test("rejects ETH on both sides", () => {
    expect(() =>
      buildV2SwapTx({
        chainId: 1,
        kind: "exactIn",
        tokenIn: ETH_SENTINEL,
        tokenOut: ETH_SENTINEL,
        amount: 1n,
        amountLimit: 1n,
        recipient: RECIPIENT,
        deadlineSeconds: DEADLINE,
      }),
    ).toThrow(/Both sides cannot be ETH/);
  });

  test("rejects unknown chainId", () => {
    expect(() =>
      buildV2SwapTx({
        chainId: 9999,
        kind: "exactIn",
        tokenIn: USDC,
        tokenOut: AUDD,
        amount: 1n,
        amountLimit: 1n,
        recipient: RECIPIENT,
        deadlineSeconds: DEADLINE,
      }),
    ).toThrow(/No Uniswap router for chainId 9999/);
  });
});

// ─── V3 ─────────────────────────────────────────────────────────────────

describe("buildV3SwapTx", () => {
  test("exactIn token→token: bare exactInputSingle", () => {
    const tx = buildV3SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: USDC,
      tokenOut: AUDD,
      fee: 3000,
      amount: 1_000_000n,
      amountLimit: 990_000n,
      recipient: RECIPIENT,
    });
    expect(tx.to.toLowerCase()).toBe(
      UNISWAP_CLIENT_ADDRESSES[1]!.v3SwapRouter02.toLowerCase(),
    );
    expect(tx.value).toBe("0");
    const decoded = v3Iface.decodeFunctionData("exactInputSingle", tx.data);
    const params = decoded[0];
    expect(params[0].toLowerCase()).toBe(USDC.toLowerCase()); // tokenIn
    expect(params[1].toLowerCase()).toBe(AUDD.toLowerCase()); // tokenOut
    expect(params[2]).toBe(3000n); // fee
    expect(params[3].toLowerCase()).toBe(RECIPIENT.toLowerCase()); // recipient
    expect(params[4]).toBe(1_000_000n); // amountIn
    expect(params[5]).toBe(990_000n); // amountOutMinimum
    expect(params[6]).toBe(0n); // sqrtPriceLimitX96
  });

  test("exactOut token→token: exactOutputSingle", () => {
    const tx = buildV3SwapTx({
      chainId: 1,
      kind: "exactOut",
      tokenIn: USDC,
      tokenOut: AUDD,
      fee: 500,
      amount: 1_000_000n, // amountOut
      amountLimit: 1_100_000n, // amountInMaximum
      recipient: RECIPIENT,
    });
    const decoded = v3Iface.decodeFunctionData("exactOutputSingle", tx.data);
    const params = decoded[0];
    expect(params[2]).toBe(500n);
    expect(params[4]).toBe(1_000_000n);
    expect(params[5]).toBe(1_100_000n);
  });

  test("ETH→token exactIn: value=amount, tokenIn=WETH, no multicall", () => {
    const tx = buildV3SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: ETH_SENTINEL,
      tokenOut: USDC,
      fee: 500,
      amount: 10n ** 18n,
      amountLimit: 1_900_000_000n,
      recipient: RECIPIENT,
    });
    expect(tx.value).toBe((10n ** 18n).toString());
    const decoded = v3Iface.decodeFunctionData("exactInputSingle", tx.data);
    expect(decoded[0][0].toLowerCase()).toBe(WETH_MAINNET.toLowerCase());
    expect(decoded[0][3].toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  test("token→ETH exactIn: multicall([exactInputSingle(recipient=address(2)), unwrapWETH9])", () => {
    const tx = buildV3SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: USDC,
      tokenOut: ETH_SENTINEL,
      fee: 500,
      amount: 2_000_000_000n,
      amountLimit: 9n * 10n ** 17n,
      recipient: RECIPIENT,
    });
    expect(tx.value).toBe("0");
    const decoded = v3Iface.decodeFunctionData("multicall(bytes[])", tx.data);
    const calls: string[] = decoded[0];
    expect(calls).toHaveLength(2);

    const swap = v3Iface.decodeFunctionData("exactInputSingle", calls[0]);
    expect(swap[0][1].toLowerCase()).toBe(WETH_MAINNET.toLowerCase()); // tokenOut → WETH
    expect(swap[0][3].toLowerCase()).toBe(ADDRESS_THIS); // recipient → router

    const unwrap = v3Iface.decodeFunctionData("unwrapWETH9", calls[1]);
    expect(unwrap[0]).toBe(9n * 10n ** 17n); // amountMinimum = amountLimit
    expect(unwrap[1].toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  test("ETH→token exactOut: value=amountInMax + refundETH in multicall", () => {
    const tx = buildV3SwapTx({
      chainId: 1,
      kind: "exactOut",
      tokenIn: ETH_SENTINEL,
      tokenOut: USDC,
      fee: 500,
      amount: 2_000_000_000n,
      amountLimit: 11n * 10n ** 17n,
      recipient: RECIPIENT,
    });
    expect(tx.value).toBe((11n * 10n ** 17n).toString());
    const decoded = v3Iface.decodeFunctionData("multicall(bytes[])", tx.data);
    const calls: string[] = decoded[0];
    expect(calls).toHaveLength(2);
    // First call is exactOutputSingle, recipient = user (not router — ETH is on the INPUT side).
    const swap = v3Iface.decodeFunctionData("exactOutputSingle", calls[0]);
    expect(swap[0][0].toLowerCase()).toBe(WETH_MAINNET.toLowerCase());
    expect(swap[0][3].toLowerCase()).toBe(RECIPIENT.toLowerCase());
    // Second call refunds the unused ETH (amountInMax − actual amountIn).
    v3Iface.decodeFunctionData("refundETH", calls[1]); // throws if shape wrong
  });

  test("deadline option wraps in multicall(uint256, bytes[])", () => {
    const tx = buildV3SwapTx({
      chainId: 1,
      kind: "exactIn",
      tokenIn: USDC,
      tokenOut: AUDD,
      fee: 3000,
      amount: 1n,
      amountLimit: 1n,
      recipient: RECIPIENT,
      deadlineSeconds: DEADLINE,
    });
    const decoded = v3Iface.decodeFunctionData(
      "multicall(uint256,bytes[])",
      tx.data,
    );
    expect(decoded[0]).toBe(BigInt(DEADLINE));
    expect(decoded[1]).toHaveLength(1);
  });

  test("Base chain uses Base router + WETH", () => {
    const tx = buildV3SwapTx({
      chainId: 8453,
      kind: "exactIn",
      tokenIn: ETH_SENTINEL,
      tokenOut: USDC,
      fee: 500,
      amount: 10n ** 18n,
      amountLimit: 1n,
      recipient: RECIPIENT,
    });
    expect(tx.to.toLowerCase()).toBe(
      UNISWAP_CLIENT_ADDRESSES[8453]!.v3SwapRouter02.toLowerCase(),
    );
    const decoded = v3Iface.decodeFunctionData("exactInputSingle", tx.data);
    expect(decoded[0][0].toLowerCase()).toBe(
      UNISWAP_CLIENT_ADDRESSES[8453]!.weth.toLowerCase(),
    );
  });
});

// ─── Slippage helpers ──────────────────────────────────────────────────

describe("slippage helpers", () => {
  test("applySlippageMin rounds down by slippage bps", () => {
    expect(applySlippageMin(10_000n, 50)).toBe(9950n); // 0.5%
    expect(applySlippageMin(10_000n, 100)).toBe(9900n); // 1%
    expect(applySlippageMin(1_000_000_000_000n, 25)).toBe(997_500_000_000n);
  });

  test("applySlippageMax rounds up by slippage bps", () => {
    expect(applySlippageMax(10_000n, 50)).toBe(10_050n);
    expect(applySlippageMax(10_000n, 100)).toBe(10_100n);
  });

  test("rejects out-of-range slippage", () => {
    expect(() => applySlippageMin(1n, -1)).toThrow();
    expect(() => applySlippageMax(1n, 10_001)).toThrow();
  });
});

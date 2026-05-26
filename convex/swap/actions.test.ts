/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { ETH_ADDRESS } from "../catalog/seed";
import {
  computeV2PairAddress,
  computeV3PoolAddress,
  feeFromQuoterCalldata,
  quoterResult,
  reservesResult,
  tokenInFromQuoterCalldata,
  tokenOutFromQuoterCalldata,
  uintResult,
} from "./abi";

// See balances/proxy.test.ts and ADR 0005 for the rationale behind the
// sibling-prefix normalization.
const FOLDER = "swap";
const raw = import.meta.glob("../**/*.ts");
const modules = Object.fromEntries(
  Object.entries(raw).map(([k, v]) =>
    k.startsWith("./") ? [`../${FOLDER}/${k.slice(2)}`, v] : [k, v],
  ),
);

// ─── Fixtures ───────────────────────────────────────────────────────────
// All addresses lowercased to match the canonical form.

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AUDD = "0x4cce605ed955295432958d8951d0b176c10720d5";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const USDC_WETH_V2_POOL = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";
const USDC_WETH_V3_500 = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const USDC_WETH_V3_3000 = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8";
const USDC_WETH_V3_10000 = "0x7bea39867e4169dbe237d55c8242a8f2fcdcc387";

// Canonical mainnet factory addresses. Used to derive expected
// CREATE2 pool addresses in tests so we stay in sync with the
// production address book.
const V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const V3_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const V3_QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";

const SELECTORS = {
  V2_PAIR_GET_RESERVES: "0x0902f1ac",
  V3_POOL_LIQUIDITY: "0x1a686502",
  V3_QUOTER_EXACT_INPUT_SINGLE: "0xc6a5026a",
  V3_QUOTER_EXACT_OUTPUT_SINGLE: "0xbd21704a",
};

// ─── Mock fetch ─────────────────────────────────────────────────────────

type Handler = (params: { to: string; data: string }) => string;
const handlers = new Map<string, Handler>();
const captured: Array<{ to: string; data: string; method: string }> = [];

function setHandler(to: string, selector: string, fn: Handler) {
  handlers.set(`${to.toLowerCase()}:${selector.toLowerCase()}`, fn);
}

beforeEach(() => {
  handlers.clear();
  captured.length = 0;
  process.env.ALCHEMY_API_KEY = "test-key";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const handleOne = (req: {
        id: number;
        method: string;
        params: unknown[];
      }) => {
        if (req.method !== "eth_call") {
          throw new Error(`Unsupported RPC method: ${req.method}`);
        }
        const cp = req.params[0] as { to: string; data: string };
        captured.push({
          to: cp.to.toLowerCase(),
          data: cp.data,
          method: req.method,
        });
        const selector = cp.data.slice(0, 10).toLowerCase();
        const key = `${cp.to.toLowerCase()}:${selector}`;
        const handler = handlers.get(key);
        if (!handler) {
          throw new Error(
            `No handler registered for ${key} (data=${cp.data.slice(0, 40)}…)`,
          );
        }
        return { jsonrpc: "2.0", id: req.id, result: handler(cp) };
      };
      const payload = Array.isArray(body) ? body.map(handleOne) : handleOne(body);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALCHEMY_API_KEY;
});

// ─── Seeders ────────────────────────────────────────────────────────────

async function seedMainnet(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.catalog.seed.addNetwork, {
    chainId: 1,
    name: "Ethereum",
    alchemySubdomain: "eth-mainnet",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isNative: true,
    enabled: true,
  });
}

async function seedV2UsdcWeth(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.catalog.seed.addUniswapPool, {
    chainId: 1,
    version: "v2",
    token0: USDC,
    token1: WETH,
    address: USDC_WETH_V2_POOL,
  });
}

async function seedV3UsdcWethAll(t: ReturnType<typeof convexTest>) {
  for (const [fee, address] of [
    [500, USDC_WETH_V3_500],
    [3000, USDC_WETH_V3_3000],
    [10000, USDC_WETH_V3_10000],
  ] as const) {
    await t.mutation(internal.catalog.seed.addUniswapPool, {
      chainId: 1,
      version: "v3",
      token0: USDC,
      token1: WETH,
      fee,
      address,
    });
  }
}

// ─── getPool ────────────────────────────────────────────────────────────

describe("uniswap.getPool", () => {
  test("v2 cached pool: skips factory, probes reserves", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    const r0 = 1_000_000n * 10n ** 6n;
    const r1 = 500n * 10n ** 18n;
    setHandler(USDC_WETH_V2_POOL, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(r0, r1),
    );

    const result = await t.action(api.swap.actions.getPool, {
      chainId: 1,
      version: "v2",
      tokenA: USDC,
      tokenB: WETH,
    });

    expect(result.address).toBe(USDC_WETH_V2_POOL);
    expect(result.token0).toBe(USDC); // USDC < WETH lexically
    expect(result.token1).toBe(WETH);
    expect(result.available).toBe(true);
    expect(result.liquidity).toBe(r0.toString());
    // Only the reserves probe — no factory call needed.
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe(USDC_WETH_V2_POOL);
  });

  test("v2 cache miss → CREATE2-derived address, no factory RPC", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    // No pool seeded. The action now derives the address locally via
    // CREATE2 and goes straight to the reserves probe — no
    // factory.getPair eth_call. Zero reserves at the derived address
    // means no pool was initialized.
    const expectedPair = computeV2PairAddress({
      factory: V2_FACTORY,
      // Token order: AUDD (0x4cce…) < USDC (0xa0b8…)
      token0: AUDD,
      token1: USDC,
    });
    setHandler(expectedPair, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(0n, 0n),
    );

    const result = await t.action(api.swap.actions.getPool, {
      chainId: 1,
      version: "v2",
      tokenA: AUDD,
      tokenB: USDC,
    });

    expect(result.address).toBeNull();
    expect(result.available).toBe(false);
    expect(result.liquidity).toBeNull();
    // The only RPC was the reserves probe at the derived address.
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe(expectedPair);
  });

  test("v2: empty eth_call response (no contract) → unavailable", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    // No contract deployed at the CREATE2 address → eth_call returns
    // plain 0x. Action should treat that as no-pool rather than try
    // to decode it.
    const expectedPair = computeV2PairAddress({
      factory: V2_FACTORY,
      token0: AUDD,
      token1: WETH,
    });
    setHandler(expectedPair, SELECTORS.V2_PAIR_GET_RESERVES, () => "0x");

    const result = await t.action(api.swap.actions.getPool, {
      chainId: 1,
      version: "v2",
      tokenA: AUDD,
      tokenB: WETH,
    });

    expect(result.address).toBeNull();
    expect(result.available).toBe(false);
    expect(result.liquidity).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe(expectedPair);
  });

  test("v3 cached pool with liquidity probe", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV3UsdcWethAll(t);
    const liq = 5n * 10n ** 20n;
    setHandler(USDC_WETH_V3_500, SELECTORS.V3_POOL_LIQUIDITY, () =>
      uintResult(liq),
    );

    const result = await t.action(api.swap.actions.getPool, {
      chainId: 1,
      version: "v3",
      tokenA: USDC,
      tokenB: WETH,
      fee: 500,
    });

    expect(result.address).toBe(USDC_WETH_V3_500);
    expect(result.fee).toBe(500);
    expect(result.available).toBe(true);
    expect(result.liquidity).toBe(liq.toString());
  });

  test("ETH sentinel resolves to WETH for pool lookup", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    setHandler(USDC_WETH_V2_POOL, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(1n, 1n),
    );

    const result = await t.action(api.swap.actions.getPool, {
      chainId: 1,
      version: "v2",
      tokenA: ETH_ADDRESS,
      tokenB: USDC,
    });
    expect(result.token0).toBe(USDC);
    expect(result.token1).toBe(WETH);
    expect(result.address).toBe(USDC_WETH_V2_POOL);
    expect(result.available).toBe(true);
  });

  test("rejects v3 without fee", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await expect(
      t.action(api.swap.actions.getPool, {
        chainId: 1,
        version: "v3",
        tokenA: USDC,
        tokenB: WETH,
      }),
    ).rejects.toThrow(/v3 pool lookup requires `fee`/);
  });

  test("rejects unknown chainId", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await expect(
      t.action(api.swap.actions.getPool, {
        chainId: 999,
        version: "v2",
        tokenA: USDC,
        tokenB: WETH,
      }),
    ).rejects.toThrow(/Unknown or disabled chainId/);
  });
});

// ─── getQuote (v2) ──────────────────────────────────────────────────────

describe("uniswap.getQuote (v2)", () => {
  test("exactIn: computes amountOut from reserves (0.3% fee)", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    const reserveUSDC = 1_000_000n * 10n ** 6n;
    const reserveWETH = 500n * 10n ** 18n;
    setHandler(USDC_WETH_V2_POOL, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(reserveUSDC, reserveWETH),
    );

    const amountIn = 1000n * 10n ** 6n; // 1000 USDC
    const result = await t.action(api.swap.actions.getQuote, {
      chainId: 1,
      version: "v2",
      tokenIn: USDC,
      tokenOut: WETH,
      kind: "exactIn",
      amount: amountIn.toString(),
    });

    // Replicate the constant-product formula with the same precision.
    const amountInWithFee = amountIn * 997n;
    const expected =
      (amountInWithFee * reserveWETH) /
      (reserveUSDC * 1000n + amountInWithFee);

    expect(result.amountIn).toBe(amountIn.toString());
    expect(result.amountOut).toBe(expected.toString());
    expect(result.poolAddress).toBe(USDC_WETH_V2_POOL);
    expect(result.version).toBe("v2");
    expect(result.tokenIn).toBe(USDC);
    expect(result.tokenOut).toBe(WETH);
  });

  test("exactOut: computes amountIn (round up)", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    const reserveUSDC = 1_000_000n * 10n ** 6n;
    const reserveWETH = 500n * 10n ** 18n;
    setHandler(USDC_WETH_V2_POOL, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(reserveUSDC, reserveWETH),
    );

    const amountOut = 1n * 10n ** 17n; // 0.1 WETH
    const result = await t.action(api.swap.actions.getQuote, {
      chainId: 1,
      version: "v2",
      tokenIn: USDC,
      tokenOut: WETH,
      kind: "exactOut",
      amount: amountOut.toString(),
    });

    const expected =
      (reserveUSDC * amountOut * 1000n) /
        ((reserveWETH - amountOut) * 997n) +
      1n;
    expect(result.amountOut).toBe(amountOut.toString());
    expect(result.amountIn).toBe(expected.toString());
  });

  test("reverses reserveIn/reserveOut when tokenIn is token1", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    const reserveUSDC = 1_000_000n * 10n ** 6n; // reserve0
    const reserveWETH = 500n * 10n ** 18n; // reserve1
    setHandler(USDC_WETH_V2_POOL, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(reserveUSDC, reserveWETH),
    );

    // tokenIn = WETH = token1; tokenOut = USDC = token0.
    const amountIn = 1n * 10n ** 18n;
    const result = await t.action(api.swap.actions.getQuote, {
      chainId: 1,
      version: "v2",
      tokenIn: WETH,
      tokenOut: USDC,
      kind: "exactIn",
      amount: amountIn.toString(),
    });

    const amountInWithFee = amountIn * 997n;
    const expected =
      (amountInWithFee * reserveUSDC) /
      (reserveWETH * 1000n + amountInWithFee);
    expect(result.amountOut).toBe(expected.toString());
  });
});

// ─── getQuote (v3) ──────────────────────────────────────────────────────

describe("uniswap.getQuote (v3)", () => {
  test("exactIn: picks best fee tier across 500/3000/10000", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV3UsdcWethAll(t);

    // Mock the quoter to return different amountOut per fee tier.
    // 500 → 1 ETH (best); 3000 → 0.5 ETH; 10000 → 0.3 ETH.
    setHandler(V3_QUOTER, SELECTORS.V3_QUOTER_EXACT_INPUT_SINGLE, ({ data }) => {
      const fee = feeFromQuoterCalldata(data);
      const amount =
        fee === 500
          ? 1n * 10n ** 18n
          : fee === 3000
            ? 5n * 10n ** 17n
            : 3n * 10n ** 17n;
      return quoterResult(amount, 79228162514264337593543950336n /* placeholder */);
    });

    const amountIn = 2000n * 10n ** 6n;
    const result = await t.action(api.swap.actions.getQuote, {
      chainId: 1,
      version: "v3",
      tokenIn: USDC,
      tokenOut: WETH,
      kind: "exactIn",
      amount: amountIn.toString(),
    });

    expect(result.fee).toBe(500);
    expect(result.amountIn).toBe(amountIn.toString());
    expect(result.amountOut).toBe((1n * 10n ** 18n).toString());
    expect(result.poolAddress).toBe(USDC_WETH_V3_500);
    expect(result.sqrtPriceX96After).toBeDefined();
    // One batched quoter call covering all three fee tiers.
    expect(captured.filter((c) => c.to === V3_QUOTER)).toHaveLength(3);
  });

  test("exactOut: picks fee tier with smallest amountIn", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV3UsdcWethAll(t);

    // 500 → needs 2100 USDC; 3000 → 2000 USDC (best, cheapest input); 10000 → 2500 USDC.
    setHandler(V3_QUOTER, SELECTORS.V3_QUOTER_EXACT_OUTPUT_SINGLE, ({ data }) => {
      const fee = feeFromQuoterCalldata(data);
      const amount =
        fee === 500
          ? 2100n * 10n ** 6n
          : fee === 3000
            ? 2000n * 10n ** 6n
            : 2500n * 10n ** 6n;
      return quoterResult(amount);
    });

    const desiredOut = 1n * 10n ** 18n; // 1 ETH
    const result = await t.action(api.swap.actions.getQuote, {
      chainId: 1,
      version: "v3",
      tokenIn: USDC,
      tokenOut: WETH,
      kind: "exactOut",
      amount: desiredOut.toString(),
    });

    expect(result.fee).toBe(3000);
    expect(result.amountIn).toBe((2000n * 10n ** 6n).toString());
    expect(result.amountOut).toBe(desiredOut.toString());
    expect(result.poolAddress).toBe(USDC_WETH_V3_3000);
  });

  test("ETH sentinel resolves to WETH in the quoter call", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV3UsdcWethAll(t);

    setHandler(V3_QUOTER, SELECTORS.V3_QUOTER_EXACT_INPUT_SINGLE, ({ data }) => {
      expect(tokenInFromQuoterCalldata(data)).toBe(WETH);
      expect(tokenOutFromQuoterCalldata(data)).toBe(USDC);
      return quoterResult(1000n * 10n ** 6n);
    });

    const result = await t.action(api.swap.actions.getQuote, {
      chainId: 1,
      version: "v3",
      tokenIn: ETH_ADDRESS,
      tokenOut: USDC,
      kind: "exactIn",
      amount: (1n * 10n ** 18n).toString(),
    });
    expect(result.tokenIn).toBe(WETH);
    expect(result.tokenOut).toBe(USDC);
  });

  test("rejects amount=0", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    await expect(
      t.action(api.swap.actions.getQuote, {
        chainId: 1,
        version: "v2",
        tokenIn: USDC,
        tokenOut: WETH,
        kind: "exactIn",
        amount: "0",
      }),
    ).rejects.toThrow(/amount must be > 0/);
  });

  test("rejects non-decimal amount", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    await expect(
      t.action(api.swap.actions.getQuote, {
        chainId: 1,
        version: "v2",
        tokenIn: USDC,
        tokenOut: WETH,
        kind: "exactIn",
        amount: "0xff",
      }),
    ).rejects.toThrow(/decimal wei string/);
  });
});

// ─── getAllQuotes ───────────────────────────────────────────────────────

describe("uniswap.getAllQuotes", () => {
  test("returns one option per venue (V2 + each V3 tier)", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    await seedV2UsdcWeth(t);
    await seedV3UsdcWethAll(t);

    const reserveUSDC = 1_000_000n * 10n ** 6n;
    const reserveWETH = 500n * 10n ** 18n;
    setHandler(USDC_WETH_V2_POOL, SELECTORS.V2_PAIR_GET_RESERVES, () =>
      reservesResult(reserveUSDC, reserveWETH),
    );
    setHandler(V3_QUOTER, SELECTORS.V3_QUOTER_EXACT_INPUT_SINGLE, ({ data }) => {
      const fee = feeFromQuoterCalldata(data);
      const amount =
        fee === 500
          ? 6n * 10n ** 17n
          : fee === 3000
            ? 5n * 10n ** 17n
            : 4n * 10n ** 17n;
      return quoterResult(amount);
    });

    const amountIn = 2000n * 10n ** 6n;
    const result = await t.action(api.swap.actions.getAllQuotes, {
      chainId: 1,
      tokenIn: USDC,
      tokenOut: WETH,
      kind: "exactIn",
      amount: amountIn.toString(),
    });

    expect(result.options).toHaveLength(4); // v2 + 3 v3 tiers
    const byKey = Object.fromEntries(
      result.options.map((o) => [`${o.version}:${o.fee ?? ""}`, o]),
    );
    expect(byKey["v2:"].available).toBe(true);
    expect(byKey["v3:500"].amountOut).toBe((6n * 10n ** 17n).toString());
    expect(byKey["v3:500"].poolAddress).toBe(USDC_WETH_V3_500);
    expect(byKey["v3:3000"].amountOut).toBe((5n * 10n ** 17n).toString());
    expect(byKey["v3:10000"].amountOut).toBe((4n * 10n ** 17n).toString());

    // V2 amountOut should match the constant-product formula.
    const amountInWithFee = amountIn * 997n;
    const v2Expected =
      (amountInWithFee * reserveWETH) /
      (reserveUSDC * 1000n + amountInWithFee);
    expect(byKey["v2:"].amountOut).toBe(v2Expected.toString());
  });

  test("marks venues without pools as unavailable instead of throwing", async () => {
    const t = convexTest(schema, modules);
    await seedMainnet(t);
    // No pools seeded. V2 reserves probe returns empty (no contract
    // at the CREATE2 address); v3 quoter has nothing to return.
    const auddWethV2 = computeV2PairAddress({
      factory: V2_FACTORY,
      // AUDD < WETH lexically.
      token0: AUDD,
      token1: WETH,
    });
    setHandler(auddWethV2, SELECTORS.V2_PAIR_GET_RESERVES, () => "0x");
    setHandler(V3_QUOTER, SELECTORS.V3_QUOTER_EXACT_INPUT_SINGLE, () => "0x");

    const result = await t.action(api.swap.actions.getAllQuotes, {
      chainId: 1,
      tokenIn: AUDD,
      tokenOut: WETH,
      kind: "exactIn",
      amount: (1n * 10n ** 6n).toString(),
    });

    expect(result.options).toHaveLength(4);
    expect(result.options.every((o) => !o.available)).toBe(true);
    expect(result.options[0].error).toBe("no pool");
  });

  // Regression guard: if CREATE2 derivation ever drifts, this test
  // will catch it before it ships. The seeded mainnet pool addresses
  // are canonical — they match what factory.getPool returns on-chain.
  test("CREATE2 derivation reproduces canonical mainnet pool addresses", () => {
    // V3 USDC/WETH at all three fee tiers.
    expect(
      computeV3PoolAddress({
        factory: V3_FACTORY,
        token0: USDC,
        token1: WETH,
        fee: 500,
      }),
    ).toBe(USDC_WETH_V3_500);
    expect(
      computeV3PoolAddress({
        factory: V3_FACTORY,
        token0: USDC,
        token1: WETH,
        fee: 3000,
      }),
    ).toBe(USDC_WETH_V3_3000);
    expect(
      computeV3PoolAddress({
        factory: V3_FACTORY,
        token0: USDC,
        token1: WETH,
        fee: 10000,
      }),
    ).toBe(USDC_WETH_V3_10000);
    // V2 USDC/WETH.
    expect(
      computeV2PairAddress({
        factory: V2_FACTORY,
        token0: USDC,
        token1: WETH,
      }),
    ).toBe(USDC_WETH_V2_POOL);
  });
});

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";
import { ETH_ADDRESS } from "./seed";
import {
  addressFromWord,
  encodeAddress,
  encodeUint,
  sliceWord,
} from "./swap/abi";

// Public Uniswap reads: pool lookup + quotes. Matches the conventions
// in refresh.ts / rpcProxy.ts:
//
//   - The Alchemy URL is composed from process.env.ALCHEMY_API_KEY
//     server-side; never returned to the client.
//   - All ABI encoding/decoding is manual hex so this stays in the
//     default Convex runtime (no ethers dependency).
//   - The client never accepts "address + selector" from us; it gets
//     structured results and builds its own transaction calldata in
//     src/lib/uniswap-swap.ts.
//
// Networks: mainnet + Base. The address book below covers both; the
// only mainnet pools that are seeded today are USDC/WETH (v2 + v3 ×
// 500/3000/10000). Everything else falls through to a factory call.

// ─── Address book ───────────────────────────────────────────────────────

type ChainAddresses = {
  v2: { factory: string; router02: string };
  v3: { factory: string; swapRouter02: string; quoterV2: string };
  weth: string;
};

// All addresses lowercased — matches the canonical form used elsewhere
// (supportedTokens.address, uniswapPools.address). `Partial<Record>`
// so an unsupported chainId is `undefined`, not a type error.
export const UNISWAP_ADDRESSES: Partial<Record<number, ChainAddresses>> = {
  1: {
    v2: {
      factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
      router02: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    },
    v3: {
      factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
      swapRouter02: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
      quoterV2: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
    },
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  },
  8453: {
    v2: {
      factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
      router02: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    },
    v3: {
      factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
      swapRouter02: "0x2626664c2603336e57b271c5c0b26f421741e481",
      quoterV2: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a",
    },
    weth: "0x4200000000000000000000000000000000000006",
  },
};

// V3 fee tiers we'll consider for "best of" routing. Skipping 100bps
// (only meaningful for stable-stable; the three big tokens here are
// already covered by 500/3000/10000).
const V3_FEE_TIERS = [500, 3000, 10000] as const;

// ─── Selectors ───────────────────────────────────────────────────────────
// Each is keccak256(signature)[0:4].

const V2_FACTORY_GET_PAIR = "0xe6a43905";
const V2_PAIR_GET_RESERVES = "0x0902f1ac";
const V2_PAIR_TOKEN0 = "0x0dfe1681";

const V3_FACTORY_GET_POOL = "0x1698ee82";
const V3_POOL_LIQUIDITY = "0x1a686502";

// IQuoterV2.quoteExact{Input,Output}Single((address,address,uint256,uint24,uint160))
const V3_QUOTER_EXACT_INPUT_SINGLE = "0xc6a5026a";
const V3_QUOTER_EXACT_OUTPUT_SINGLE = "0xbd21704a";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Tiny ABI helpers ────────────────────────────────────────────────────

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

type RpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};
type RpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as RpcResponse<T>;
  if (body.error) {
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error("RPC returned no result");
  }
  return body.result;
}

async function rpcBatch<T>(
  url: string,
  calls: Array<RpcRequest>,
): Promise<Array<RpcResponse<T>>> {
  if (calls.length === 0) return [];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as Array<RpcResponse<T>>;
  if (!Array.isArray(body)) throw new Error("RPC response was not an array");
  return body;
}

function ethCall(to: string, data: string): { to: string; data: string } {
  return { to, data };
}

// ─── Internal helpers ────────────────────────────────────────────────────

export const _networkForUniswap = internalQuery({
  args: { chainId: v.number() },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network || !network.enabled) return null;
    return {
      _id: network._id,
      alchemySubdomain: network.alchemySubdomain,
    };
  },
});

export const _cachedPool = internalQuery({
  args: {
    chainId: v.number(),
    version: v.union(v.literal("v2"), v.literal("v3")),
    token0: v.string(),
    token1: v.string(),
    fee: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) return null;
    const row = await ctx.db
      .query("uniswapPools")
      .withIndex("by_pair", (q) =>
        q
          .eq("networkId", network._id)
          .eq("version", args.version)
          .eq("token0", args.token0)
          .eq("token1", args.token1)
          .eq("fee", args.fee),
      )
      .unique();
    if (!row || !row.enabled) return null;
    return { address: row.address };
  },
});

// ─── Canonical token resolution ─────────────────────────────────────────
// ETH sentinel → WETH for pool lookups; both tokens lowercased; sorted
// so token0 < token1.

function resolveTokenForPool(addr: string, chainId: number): string {
  const lower = addr.toLowerCase();
  if (lower === ETH_ADDRESS) {
    const book = UNISWAP_ADDRESSES[chainId];
    if (!book) throw new Error(`No Uniswap address book for chain ${chainId}`);
    return book.weth;
  }
  return normalizeAddress(lower);
}

function sortPair(
  a: string,
  b: string,
): { token0: string; token1: string; swapped: boolean } {
  return a < b
    ? { token0: a, token1: b, swapped: false }
    : { token0: b, token1: a, swapped: true };
}

// Build the factory.get{Pair,Pool} calldata for cache-miss lookups.
function buildFactoryCall(args: {
  version: "v2" | "v3";
  token0: string;
  token1: string;
  fee?: number;
  book: ChainAddresses;
}): { to: string; data: string } {
  if (args.version === "v2") {
    return {
      to: args.book.v2.factory,
      data:
        V2_FACTORY_GET_PAIR +
        encodeAddress(args.token0) +
        encodeAddress(args.token1),
    };
  }
  if (args.fee === undefined) throw new Error("v3 fee required");
  return {
    to: args.book.v3.factory,
    data:
      V3_FACTORY_GET_POOL +
      encodeAddress(args.token0) +
      encodeAddress(args.token1) +
      encodeUint(BigInt(args.fee)),
  };
}

// ─── getPool ─────────────────────────────────────────────────────────────

export type PoolResult = {
  chainId: number;
  version: "v2" | "v3";
  token0: string;
  token1: string;
  fee?: number;
  address: string | null; // null if no pool exists
  liquidity: string | null; // v2: token0 reserve; v3: liquidity(). null if no pool.
  available: boolean; // address != 0x0 AND liquidity > 0
};

export const getPool = action({
  args: {
    chainId: v.number(),
    version: v.union(v.literal("v2"), v.literal("v3")),
    tokenA: v.string(),
    tokenB: v.string(),
    fee: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PoolResult> => {
    const network: { alchemySubdomain: string } | null = await ctx.runQuery(
      internal.uniswap._networkForUniswap,
      { chainId: args.chainId },
    );
    if (!network) {
      throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    }
    if (args.version === "v3" && args.fee === undefined) {
      throw new Error("v3 pool lookup requires `fee`");
    }
    const book = UNISWAP_ADDRESSES[args.chainId];
    if (!book) throw new Error(`No Uniswap address book for chain ${args.chainId}`);

    const tokenA = resolveTokenForPool(args.tokenA, args.chainId);
    const tokenB = resolveTokenForPool(args.tokenB, args.chainId);
    const { token0, token1 } = sortPair(tokenA, tokenB);
    const url = alchemyUrl(network.alchemySubdomain);

    // 1. DB cache.
    const cached: { address: string } | null = await ctx.runQuery(
      internal.uniswap._cachedPool,
      {
        chainId: args.chainId,
        version: args.version,
        token0,
        token1,
        fee: args.fee,
      },
    );

    let address: string | null = cached ? cached.address : null;

    // 2. Cache miss → factory.
    if (!address) {
      const call = buildFactoryCall({
        version: args.version,
        token0,
        token1,
        fee: args.fee,
        book,
      });
      const hex = await rpc<string>(url, "eth_call", [
        ethCall(call.to, call.data),
        "latest",
      ]);
      if (!hex || hex === "0x" || hex.length < 66) {
        address = ZERO_ADDRESS;
      } else {
        address = addressFromWord(hex.slice(2));
      }
    }

    if (address === ZERO_ADDRESS) {
      return {
        chainId: args.chainId,
        version: args.version,
        token0,
        token1,
        fee: args.fee,
        address: null,
        liquidity: null,
        available: false,
      };
    }

    // 3. Liquidity probe.
    let liquidity: bigint;
    if (args.version === "v2") {
      const hex = await rpc<string>(url, "eth_call", [
        ethCall(address, V2_PAIR_GET_RESERVES),
        "latest",
      ]);
      const { reserve0 } = decodeV2Reserves(hex);
      liquidity = reserve0;
    } else {
      const hex = await rpc<string>(url, "eth_call", [
        ethCall(address, V3_POOL_LIQUIDITY),
        "latest",
      ]);
      liquidity = BigInt(hex);
    }

    return {
      chainId: args.chainId,
      version: args.version,
      token0,
      token1,
      fee: args.fee,
      address,
      liquidity: liquidity.toString(),
      available: liquidity > 0n,
    };
  },
});

// ─── V2 reserves decoder ────────────────────────────────────────────────

function decodeV2Reserves(hex: string): {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: number;
} {
  if (!hex || !hex.startsWith("0x")) throw new Error(`Bad reserves hex: ${hex}`);
  const data = hex.slice(2);
  if (data.length < 64 * 3) {
    throw new Error(`reserves payload too short: ${data.length} chars`);
  }
  return {
    reserve0: BigInt("0x" + sliceWord(data, 0)),
    reserve1: BigInt("0x" + sliceWord(data, 1)),
    blockTimestampLast: Number(BigInt("0x" + sliceWord(data, 2))),
  };
}

// V2 constant-product formula with the standard 0.3% fee.
//   amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
function v2GetAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) throw new Error("amountIn must be > 0");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("insufficient liquidity");
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

// Inverse: how much input is needed for a desired output.
//   amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1
function v2GetAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n) throw new Error("amountOut must be > 0");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("insufficient liquidity");
  if (amountOut >= reserveOut) throw new Error("amountOut exceeds reserves");
  const numerator = reserveIn * amountOut * 1000n;
  const denominator = (reserveOut - amountOut) * 997n;
  return numerator / denominator + 1n;
}

// ─── getQuote ────────────────────────────────────────────────────────────

export type QuoteKind = "exactIn" | "exactOut";

export type QuoteResult = {
  chainId: number;
  version: "v2" | "v3";
  kind: QuoteKind;
  tokenIn: string; // resolved (WETH if ETH sentinel was passed)
  tokenOut: string;
  amountIn: string; // wei
  amountOut: string; // wei
  poolAddress: string;
  fee?: number; // v3
  sqrtPriceX96After?: string; // v3 only
  fetchedAt: number;
};

export const getQuote = action({
  args: {
    chainId: v.number(),
    version: v.union(v.literal("v2"), v.literal("v3")),
    tokenIn: v.string(),
    tokenOut: v.string(),
    kind: v.union(v.literal("exactIn"), v.literal("exactOut")),
    // Decimal wei string so values bigger than Number.MAX_SAFE_INTEGER
    // survive the wire.
    amount: v.string(),
  },
  handler: async (ctx, args): Promise<QuoteResult> => {
    const network: { alchemySubdomain: string } | null = await ctx.runQuery(
      internal.uniswap._networkForUniswap,
      { chainId: args.chainId },
    );
    if (!network) {
      throw new Error(`Unknown or disabled chainId ${args.chainId}`);
    }
    const book = UNISWAP_ADDRESSES[args.chainId];
    if (!book) throw new Error(`No Uniswap address book for chain ${args.chainId}`);

    const tokenIn = resolveTokenForPool(args.tokenIn, args.chainId);
    const tokenOut = resolveTokenForPool(args.tokenOut, args.chainId);
    const amount = parseAmount(args.amount);
    const fetchedAt = Date.now();
    const url = alchemyUrl(network.alchemySubdomain);

    const { token0, token1 } = sortPair(tokenIn, tokenOut);

    if (args.version === "v2") {
      // 1. Resolve pool — cache, then factory.
      const cached: { address: string } | null = await ctx.runQuery(
        internal.uniswap._cachedPool,
        {
          chainId: args.chainId,
          version: "v2",
          token0,
          token1,
        },
      );
      let poolAddress = cached ? cached.address : null;
      if (!poolAddress) {
        const call = buildFactoryCall({
          version: "v2",
          token0,
          token1,
          book,
        });
        const hex = await rpc<string>(url, "eth_call", [
          ethCall(call.to, call.data),
          "latest",
        ]);
        poolAddress = !hex || hex.length < 66 ? null : addressFromWord(hex.slice(2));
      }
      if (!poolAddress || poolAddress === ZERO_ADDRESS) {
        throw new Error(`No v2 pool for ${tokenIn} / ${tokenOut}`);
      }

      // 2. Read reserves + compute.
      const hex = await rpc<string>(url, "eth_call", [
        ethCall(poolAddress, V2_PAIR_GET_RESERVES),
        "latest",
      ]);
      const { reserve0, reserve1 } = decodeV2Reserves(hex);
      const tokenInIsToken0 = tokenIn === token0;
      const reserveIn = tokenInIsToken0 ? reserve0 : reserve1;
      const reserveOut = tokenInIsToken0 ? reserve1 : reserve0;

      let amountIn: bigint;
      let amountOut: bigint;
      if (args.kind === "exactIn") {
        amountIn = amount;
        amountOut = v2GetAmountOut(amountIn, reserveIn, reserveOut);
      } else {
        amountOut = amount;
        amountIn = v2GetAmountIn(amountOut, reserveIn, reserveOut);
      }

      return {
        chainId: args.chainId,
        version: "v2",
        kind: args.kind,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        poolAddress,
        fetchedAt,
      };
    }

    // ── v3: quote every fee tier, pick the best, then resolve pool. ──
    const selector =
      args.kind === "exactIn"
        ? V3_QUOTER_EXACT_INPUT_SINGLE
        : V3_QUOTER_EXACT_OUTPUT_SINGLE;

    const batch: Array<RpcRequest> = V3_FEE_TIERS.map((fee, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "eth_call",
      params: [
        ethCall(
          book.v3.quoterV2,
          buildQuoterCalldata({
            selector,
            tokenIn,
            tokenOut,
            amount,
            fee,
          }),
        ),
        "latest",
      ],
    }));

    const responses = await rpcBatch<string>(url, batch);
    type Candidate = {
      fee: number;
      amount: bigint;
      sqrtPriceX96After: bigint;
    };
    const candidates: Candidate[] = [];
    for (let i = 0; i < V3_FEE_TIERS.length; i++) {
      const resp = responses.find((r) => r.id === i) ?? responses[i];
      if (resp.error || !resp.result) continue;
      try {
        const decoded = decodeQuoterResponse(resp.result);
        candidates.push({
          fee: V3_FEE_TIERS[i],
          amount: decoded.amount,
          sqrtPriceX96After: decoded.sqrtPriceX96After,
        });
      } catch {
        // Pool doesn't exist for this fee tier; quoter reverts/returns short.
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `No v3 pool with liquidity for ${tokenIn} / ${tokenOut} across ${V3_FEE_TIERS.join("/")}`,
      );
    }

    // Best: max amountOut for exactIn; min amountIn for exactOut.
    const best =
      args.kind === "exactIn"
        ? candidates.reduce((a, b) => (b.amount > a.amount ? b : a))
        : candidates.reduce((a, b) => (b.amount < a.amount ? b : a));

    // Resolve pool address — DB cache for the winning tier, factory fallback.
    const cachedWinner: { address: string } | null = await ctx.runQuery(
      internal.uniswap._cachedPool,
      {
        chainId: args.chainId,
        version: "v3",
        token0,
        token1,
        fee: best.fee,
      },
    );
    let poolAddress: string;
    if (cachedWinner) {
      poolAddress = cachedWinner.address;
    } else {
      const call = buildFactoryCall({
        version: "v3",
        token0,
        token1,
        fee: best.fee,
        book,
      });
      const hex = await rpc<string>(url, "eth_call", [
        ethCall(call.to, call.data),
        "latest",
      ]);
      poolAddress = addressFromWord(hex.slice(2));
    }

    const amountIn = args.kind === "exactIn" ? amount : best.amount;
    const amountOut = args.kind === "exactIn" ? best.amount : amount;
    return {
      chainId: args.chainId,
      version: "v3",
      kind: args.kind,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      poolAddress,
      fee: best.fee,
      sqrtPriceX96After: best.sqrtPriceX96After.toString(),
      fetchedAt,
    };
  },
});

function parseAmount(s: string): bigint {
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`amount must be a decimal wei string, got "${s}"`);
  }
  const n = BigInt(s);
  if (n <= 0n) throw new Error("amount must be > 0");
  return n;
}

function buildQuoterCalldata(args: {
  selector: string;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  fee: number;
  sqrtPriceLimitX96?: bigint;
}): string {
  // QuoteExact{Input,Output}SingleParams is a static struct — the
  // calldata is just the selector followed by 5 packed 32-byte words.
  // No offset/length gymnastics needed.
  return (
    args.selector +
    encodeAddress(args.tokenIn) +
    encodeAddress(args.tokenOut) +
    encodeUint(args.amount) +
    encodeUint(BigInt(args.fee)) +
    encodeUint(args.sqrtPriceLimitX96 ?? 0n)
  );
}

function decodeQuoterResponse(hex: string): {
  amount: bigint;
  sqrtPriceX96After: bigint;
} {
  if (!hex || !hex.startsWith("0x") || hex.length < 2 + 64 * 4) {
    throw new Error(`Bad quoter response: ${hex}`);
  }
  const data = hex.slice(2);
  return {
    amount: BigInt("0x" + sliceWord(data, 0)),
    sqrtPriceX96After: BigInt("0x" + sliceWord(data, 1)),
  };
}

// Re-exported for tests + reference; never imported by the client.
export const SELECTORS = {
  V2_FACTORY_GET_PAIR,
  V2_PAIR_GET_RESERVES,
  V2_PAIR_TOKEN0,
  V3_FACTORY_GET_POOL,
  V3_POOL_LIQUIDITY,
  V3_QUOTER_EXACT_INPUT_SINGLE,
  V3_QUOTER_EXACT_OUTPUT_SINGLE,
};

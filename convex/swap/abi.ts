// Shared ABI helpers for the Uniswap / swap code path. Lives here so
// both convex/uniswap.ts (production encoders) and the test fixture
// builders in convex/uniswap.test.ts can use the same primitives —
// otherwise the same 32-byte word logic ends up duplicated in two
// places and starts drifting.
//
// Two groups of exports:
//
//   1. Generic 32-byte word helpers (pad32, encodeAddress, encodeUint,
//      sliceWord, addressFromWord). Used by the production action to
//      build / decode `eth_call` payloads.
//
//   2. Uniswap-specific encoders/decoders (reservesResult, quoterResult,
//      feeFromQuoterCalldata). Used by tests to canned-mock the
//      Alchemy responses and introspect what the action sent.

// ─── Generic 32-byte word helpers ───────────────────────────────────────

export function pad32(hexNo0x: string): string {
  if (hexNo0x.length > 64) throw new Error("encode overflow");
  return "0".repeat(64 - hexNo0x.length) + hexNo0x;
}

export function encodeAddress(addr: string): string {
  const a = addr.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    throw new Error(`Invalid address: ${addr}`);
  }
  return pad32(a.slice(2));
}

export function encodeUint(n: bigint): string {
  if (n < 0n) throw new Error("uint cannot be negative");
  return pad32(n.toString(16));
}

/** Slice the i-th 32-byte word out of a (no-`0x`) hex blob. */
export function sliceWord(hexNo0x: string, i: number): string {
  return hexNo0x.slice(i * 64, (i + 1) * 64);
}

/** Pull a 20-byte address out of a 32-byte word (last 20 bytes). */
export function addressFromWord(word: string): string {
  return "0x" + word.slice(24).toLowerCase();
}

// ─── Test-fixture builders ──────────────────────────────────────────────
// These match the *return* shape of the on-chain calls the production
// action issues. Convenient for mocking Alchemy in tests.

/** Build an `eth_call` result hex for a bare uint256 return. */
export function uintResult(n: bigint): string {
  return "0x" + encodeUint(n);
}

/** Build an `eth_call` result hex for a bare address return. */
export function addressResult(addr: string): string {
  return "0x" + encodeAddress(addr);
}

/**
 * Build the return payload of `UniswapV2Pair.getReserves()`:
 *   (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
 */
export function reservesResult(
  reserve0: bigint,
  reserve1: bigint,
  blockTimestampLast = 0,
): string {
  return (
    "0x" +
    encodeUint(reserve0) +
    encodeUint(reserve1) +
    encodeUint(BigInt(blockTimestampLast))
  );
}

/**
 * Build the return payload of `IQuoterV2.quoteExact{Input,Output}Single`:
 *   (uint256 amount, uint160 sqrtPriceX96After,
 *    uint32 initializedTicksCrossed, uint256 gasEstimate)
 */
export function quoterResult(
  amount: bigint,
  sqrtPriceX96After = 0n,
  ticksCrossed = 0n,
  gasEstimate = 100_000n,
): string {
  return (
    "0x" +
    encodeUint(amount) +
    encodeUint(sqrtPriceX96After) +
    encodeUint(ticksCrossed) +
    encodeUint(gasEstimate)
  );
}

// ─── Calldata introspection ─────────────────────────────────────────────
// QuoterV2 calldata layout (static struct, no offset/length prelude):
//   "0x" + selector(8) + tokenIn(64) + tokenOut(64) +
//          amount(64) + fee(64) + sqrtPriceLimit(64)
//
// Helpers below let a test mock inspect the params it received so it
// can vary the canned response per fee tier / per token pair without
// duplicating the layout knowledge.

const QUOTER_SELECTOR_LEN = 2 + 8; // "0x" + 4 bytes

function quoterParam(data: string, slot: 0 | 1 | 2 | 3 | 4): string {
  const start = QUOTER_SELECTOR_LEN + slot * 64;
  return data.slice(start, start + 64);
}

export function tokenInFromQuoterCalldata(data: string): string {
  return addressFromWord(quoterParam(data, 0));
}

export function tokenOutFromQuoterCalldata(data: string): string {
  return addressFromWord(quoterParam(data, 1));
}

export function amountFromQuoterCalldata(data: string): bigint {
  return BigInt("0x" + quoterParam(data, 2));
}

export function feeFromQuoterCalldata(data: string): number {
  return Number("0x" + quoterParam(data, 3));
}

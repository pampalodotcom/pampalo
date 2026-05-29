// Boundary normalization for chain-touching data. Used by the indexer
// and seed paths to canonicalise hex addresses / hashes / uint256
// fields before they hit Convex tables, so indexed lookups can't miss
// because of EIP-55 checksum drift and so uint256 amounts survive
// the JS Number 2^53 ceiling.
//
// Conventions, applied at every read/write boundary:
//   - All EVM addresses + tx hashes are STORED LOWERCASED.
//   - All uint256 values (amounts, pendingIds, leaf commitments) are
//     STORED AS BASE-10 STRINGS — never `v.number()`.
//
// See SHIELD_FLOW.md §2.4 for the rationale.

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES_RE = /^0x[0-9a-fA-F]*$/;

/** Lowercase a 20-byte hex address; throw on malformed input. */
export function lowerAddress(value: string): string {
  if (!HEX_ADDR_RE.test(value)) {
    throw new Error(`not a 20-byte hex address: ${value}`);
  }
  return value.toLowerCase();
}

/** Lowercase a 32-byte hex hash (tx hash or leaf commitment). */
export function lowerHash(value: string): string {
  if (!HEX_HASH_RE.test(value)) {
    throw new Error(`not a 32-byte hex value: ${value}`);
  }
  return value.toLowerCase();
}

/** Lowercase an arbitrary 0x-prefixed hex blob (variable length). */
export function lowerHex(value: string): string {
  if (!HEX_BYTES_RE.test(value)) {
    throw new Error(`not a 0x-prefixed hex string: ${value}`);
  }
  return value.toLowerCase();
}

/**
 * Stringify a uint256 as base-10. JS Number can only safely represent
 * integers up to 2^53; Convex's `v.number()` is a float64, so storing
 * amounts there silently truncates anything past that ceiling (any
 * realistic ETH or large USDC amount). We store as a decimal string
 * and convert back to bigint at read time.
 *
 * NOT lexicographically sortable — don't build an index on these.
 */
export function uint256ToString(value: bigint): string {
  if (value < 0n) {
    throw new Error(`uint256 cannot be negative: ${value}`);
  }
  return value.toString(10);
}

/** Inverse of `uint256ToString`. Throws on non-decimal input. */
export function stringToUint256(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`not a decimal uint256 string: ${value}`);
  }
  return BigInt(value);
}

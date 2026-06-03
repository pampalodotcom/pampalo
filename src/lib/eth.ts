// Project-wide ETH-side constants. Single source of truth so we don't
// drift between modules when adding a new chain or contract.

/**
 * Sentinel address that represents native ETH in any context that
 * normally expects an ERC-20 token address (the swap/send/shield
 * paths, the Pampalo `supportedAssets` mapping, the Convex catalog).
 *
 * Matches the convention used by 1inch / OKX / Pampalo's on-chain
 * `Pampalo.ETH_ADDRESS` constant. Stored lowercased — every comparison
 * site should lowercase its input before checking equality.
 */
export const ETH_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isNativeAsset(address: string): boolean {
  return address.toLowerCase() === ETH_SENTINEL;
}

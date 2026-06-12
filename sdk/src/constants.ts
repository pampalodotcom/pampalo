// Sentinel for native ETH in (asset, amount) tuples — mirrors
// `Pampalo.ETH_ADDRESS` and shared/constants/tree.ts. Lowercased compares.
export const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export function isNativeAsset(asset?: string): boolean {
  return !asset || asset.toLowerCase() === ETH_SENTINEL.toLowerCase();
}

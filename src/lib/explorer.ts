// Block-explorer URL helpers. Mapping is hand-maintained for the
// chains the wallet ships on. Add new entries as `pampaloDeployments`
// (or `supportedNetworks`) grows.

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  11155111: "https://sepolia.etherscan.io",
  84532: "https://sepolia.basescan.org",
  421614: "https://sepolia.arbiscan.io",
};

/**
 * Block-explorer base URL for a chainId, or `null` if we don't have a
 * mapping. Callers should fall back to plain text (no link) on null.
 */
export function explorerBase(chainId: number): string | null {
  return EXPLORERS[chainId] ?? null;
}

/** Full URL to a tx page on the chain's explorer, or null. */
export function txUrl(chainId: number, txHash: string): string | null {
  const base = explorerBase(chainId);
  if (!base) return null;
  return `${base}/tx/${txHash}`;
}

/** Full URL to an address page on the chain's explorer, or null. */
export function addressUrl(chainId: number, address: string): string | null {
  const base = explorerBase(chainId);
  if (!base) return null;
  return `${base}/address/${address}`;
}

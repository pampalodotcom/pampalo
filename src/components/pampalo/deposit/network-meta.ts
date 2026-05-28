// Human-facing one-liner shown under a network's name on the deposit
// picker. Kept client-side because the catalog row doesn't carry
// marketing copy — it's pure infrastructure metadata.

export function taglineForChainId(chainId: number): string {
  switch (chainId) {
    case 1:
      return "L1 · Settlement";
    case 8453:
      return "L2 · Lower fees";
    case 42161:
      return "L2 · Lower fees";
    case 11155111:
      return "Testnet · Ethereum";
    case 421614:
      return "Testnet · Arbitrum";
    case 84532:
      return "Testnet · Base";
    default:
      return "EVM network";
  }
}

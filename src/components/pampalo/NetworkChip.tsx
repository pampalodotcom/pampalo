import { cn } from "@/lib/utils";

// Public network slugs. Mapped to colour-dot classes in styles.css.
export type NetworkSlug = "eth" | "base" | "arb" | "sepolia";

const LABELS: Record<NetworkSlug, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  sepolia: "Sepolia",
};

/** Map a chainId from supportedNetworks → slug. Centralised so the
 *  client decides the chip's brand colour from a single place. */
export function networkSlugForChainId(chainId: number): NetworkSlug | null {
  switch (chainId) {
    case 1:
      return "eth";
    case 8453:
      return "base";
    case 42161:
    case 421614:
      return "arb";
    case 11155111:
      return "sepolia";
    default:
      return null;
  }
}

export function NetworkChip({
  network,
  label,
  className,
}: {
  network: NetworkSlug;
  /** Optional override; defaults to the canonical label for the slug. */
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("net-chip", network, className)}>
      {label ?? LABELS[network]}
    </span>
  );
}

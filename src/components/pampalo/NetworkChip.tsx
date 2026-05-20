import { cn } from "@/lib/utils";

// Public network slugs. Mapped to colour-dot classes in styles.css.
export type NetworkSlug = "eth" | "base" | "arb" | "sepolia";

const LABELS: Record<NetworkSlug, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  sepolia: "Sepolia",
};

// Optional per-network logo. Networks without an entry fall back to the
// CSS colour dot defined in styles.css.
const LOGOS: Partial<Record<NetworkSlug, string>> = {
  base: "/base-logo.svg",
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
  const logo = LOGOS[network];
  // When a logo is registered, suppress the CSS `::before` dot and render
  // an inline <img> instead. The `has-logo` modifier in styles.css hides
  // the dot for this case.
  return (
    <span className={cn("net-chip", network, logo && "has-logo", className)}>
      {logo && (
        <img
          src={logo}
          alt=""
          aria-hidden
          width={10}
          height={10}
          className="size-2.5 rounded-[2px]"
          draggable={false}
        />
      )}
      {label ?? LABELS[network]}
    </span>
  );
}

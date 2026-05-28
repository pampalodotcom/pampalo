import { cn } from "@/lib/utils";
import {
  networkSlugForChainId,
  type NetworkSlug,
} from "@/components/pampalo/NetworkChip";

// Circular brand disc for a single network. Mirrors AssetMark's
// rendering pattern (image inside a clipped circle, dropped shadow,
// subtle inset highlight) so the network logos on the deposit picker
// read in the same visual register as the token logos on the assets
// list — same disc treatment, just a different layer of the stack.

type NetworkVisual = {
  /** Public image asset path. When present, takes priority over `glyph`. */
  image?: string;
  /** Single-character fallback glyph. */
  glyph?: string;
  /** Disc background colour. */
  bg: string;
  /** Glyph colour. Unused when `image` is set. */
  fg: string;
};

const VISUALS: Partial<Record<NetworkSlug, NetworkVisual>> = {
  // Matches AssetMark's ETH visual exactly so the deposit picker and
  // the asset row look like the same disc.
  eth: { image: "/eth-logo.png", bg: "#0C2236", fg: "#FAF6EA" },
  // Base ships the brand mark as a solid blue square SVG — used as
  // the image so the disc reads as Base-blue without us having to
  // hand-roll a glyph.
  base: { image: "/base-logo.svg", bg: "#0052FF", fg: "#FFFFFF" },
  arb: { glyph: "Λ", bg: "#28A0F0", fg: "#FFFFFF" },
  sepolia: { glyph: "S", bg: "#5d4ec9", fg: "#FFFFFF" },
};

const FALLBACK: NetworkVisual = {
  glyph: "•",
  bg: "var(--color-ink)",
  fg: "var(--color-paper)",
};

const SHADOW =
  "0 4px 12px rgba(12,34,54,0.18), inset 0 1px 0 rgba(255,255,255,0.18)";

export function NetworkLogo({
  chainId,
  size = 40,
  className,
}: {
  chainId: number;
  size?: number;
  className?: string;
}) {
  const slug = networkSlugForChainId(chainId);
  const visual = (slug ? VISUALS[slug] : undefined) ?? FALLBACK;

  if (visual.image) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
          className,
        )}
        style={{
          width: size,
          height: size,
          background: visual.bg,
          boxShadow: SHADOW,
        }}
        aria-hidden="true"
      >
        <img
          src={visual.image}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-serif font-bold leading-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: visual.bg,
        color: visual.fg,
        fontSize: Math.round(size * 0.5),
        boxShadow: SHADOW,
      }}
      aria-hidden="true"
    >
      {visual.glyph}
    </span>
  );
}

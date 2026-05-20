import { cn } from "@/lib/utils";

// Per-asset visual. When `image` is set, the disc renders the logo (clipped
// to a circle). When it isn't, falls back to a coloured disc with a
// stylised glyph — used for any symbol we haven't registered a logo for.
type AssetVisual = {
  image?: string;
  glyph: string;
  bg: string;
  fg: string;
  // Source logo is white-on-transparent and vanishes against the paper
  // background in light mode; invert it so it reads as dark ink.
  invertOnLight?: boolean;
};

const VISUALS: Record<string, AssetVisual> = {
  ETH: { image: "/eth-logo.png", glyph: "Ξ", bg: "#0C2236", fg: "#FAF6EA" },
  USDC: { image: "/usdc-logo.png", glyph: "$", bg: "#2E7DC2", fg: "#FFFFFF" },
  AUDD: {
    image: "/audd-logo.png",
    glyph: "A$",
    bg: "#C44530",
    fg: "#FFFBF0",
    invertOnLight: true,
  },
  LINK: { image: "/link-logo.png", glyph: "L", bg: "#2A5ADA", fg: "#FFFFFF" },
};

const FALLBACK: AssetVisual = {
  glyph: "•",
  bg: "var(--color-ink)",
  fg: "var(--color-paper)",
};

export function AssetMark({
  symbol,
  size = 40,
  className,
}: {
  symbol: string;
  size?: number;
  className?: string;
}) {
  const visual = VISUALS[symbol] ?? FALLBACK;

  if (visual.image) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-card",
          className,
        )}
        style={{
          width: size,
          height: size,
          boxShadow:
            "0 4px 12px rgba(12,34,54,0.18), inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
        aria-hidden="true"
      >
        <img
          src={visual.image}
          alt=""
          width={size}
          height={size}
          className={cn(
            "h-full w-full object-cover",
            visual.invertOnLight && "asset-mark-invert-light",
          )}
          draggable={false}
        />
      </span>
    );
  }

  const isLong = visual.glyph.length > 1;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "rounded-full font-serif font-bold leading-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: visual.bg,
        color: visual.fg,
        fontSize: isLong ? size * 0.4 : size * 0.5,
        letterSpacing: visual.glyph === "Ξ" ? 0 : "-0.02em",
        boxShadow:
          "0 4px 12px rgba(12,34,54,0.18), inset 0 1px 0 rgba(255,255,255,0.18)",
      }}
      aria-hidden="true"
    >
      {visual.glyph}
    </span>
  );
}

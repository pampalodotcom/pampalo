import { cn } from "@/lib/utils";

// Each asset has its own coloured disc with the ticker glyph. Colours
// lifted from the design handoff (ETH = ink, USDC = calm blue, AUDD =
// umbrella red from the landing scene).
type AssetVisual = {
  glyph: string;
  bg: string;
  fg: string;
};

const VISUALS: Record<string, AssetVisual> = {
  ETH: { glyph: "Ξ", bg: "#0C2236", fg: "#FAF6EA" },
  USDC: { glyph: "$", bg: "#2E7DC2", fg: "#FFFFFF" },
  AUDD: { glyph: "A$", bg: "#C44530", fg: "#FFFBF0" },
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

import { MoonIcon, SunIcon } from "pampalo";

// Moon = private (shielded) funds throughout the wallet. Default size is
// 12px, so cells render on labeled chips at generous sizes.

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 14px",
  borderRadius: 12,
  border: "1px solid var(--color-line)",
  background: "var(--color-paper-lo)",
};

const caption: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
    {[12, 16, 24, 32].map((size) => (
      <div
        key={size}
        style={{
          ...chip,
          flexDirection: "column",
          gap: 6,
          color: "var(--color-priv)",
        }}
      >
        <MoonIcon size={size} />
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--color-ink-mute)",
          }}
        >
          {size}px
        </span>
      </div>
    ))}
  </div>
);

// The AssetRow "Private" column header: moon glyph + uppercase label + amount.
export const PrivateColumnHeader = () => (
  <div style={{ ...chip, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--color-priv)",
      }}
    >
      <MoonIcon size={14} />
      <span style={caption}>Private</span>
    </div>
    <span className="font-mono text-[13.5px] font-semibold text-ink">
      1.2500 ETH
    </span>
  </div>
);

// Shield direction as it reads in the move flow: sun (public) -> moon (private).
export const ShieldDirection = () => (
  <div style={{ ...chip, gap: 10 }}>
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-pub)" }}>
      <SunIcon size={16} />
      <span style={caption}>Public</span>
    </span>
    <span style={{ color: "var(--color-ink-mute)", fontSize: 13 }}>→</span>
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-priv)" }}>
      <MoonIcon size={16} />
      <span style={caption}>Private</span>
    </span>
    <span className="font-mono text-[13px] font-semibold text-ink">
      0.42 ETH
    </span>
  </div>
);

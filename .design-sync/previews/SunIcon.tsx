import { SunIcon, MoonIcon } from "pampalo";

// Sun = public funds throughout the wallet. Default size is 12px, so cells
// render on labeled chips at generous sizes to stay legible in screenshots.

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
          color: "var(--color-pub)",
        }}
      >
        <SunIcon size={size} />
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

// The AssetRow "Public" column header: sun glyph + uppercase label + amount.
export const PublicColumnHeader = () => (
  <div style={{ ...chip, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--color-pub)",
      }}
    >
      <SunIcon size={14} />
      <span style={caption}>Public</span>
    </div>
    <span className="font-mono text-[13.5px] font-semibold text-ink">
      0.7500 ETH
    </span>
  </div>
);

// Sun/moon pairing as it reads across the app: public vs private balance.
export const PublicPrivatePairing = () => (
  <div style={{ display: "flex", gap: 12 }}>
    <div style={{ ...chip, color: "var(--color-pub)" }}>
      <SunIcon size={18} />
      <span style={caption}>Public</span>
      <span className="font-mono text-[13px] font-semibold text-ink">
        1,840.50 USDC
      </span>
    </div>
    <div style={{ ...chip, color: "var(--color-priv)" }}>
      <MoonIcon size={18} />
      <span style={caption}>Private</span>
      <span className="font-mono text-[13px] font-semibold text-ink">
        620.00 USDC
      </span>
    </div>
  </div>
);

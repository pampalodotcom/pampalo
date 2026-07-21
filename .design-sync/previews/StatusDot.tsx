import { StatusDot } from "pampalo";

export const Default = () => <StatusDot />;

export const WalletStates = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <StatusDot label="Signed in" />
    <StatusDot label="Connected · Ethereum" />
    <StatusDot label="Connected · Base" />
    <StatusDot label="Private balance synced" />
  </div>
);

// On a card header, where it marks the session as live.
export const OnCard = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      width: 360,
      padding: "12px 16px",
      borderRadius: 14,
      border: "1px solid var(--color-line)",
      background: "var(--color-paper-lo)",
    }}
  >
    <span className="text-[13px] font-semibold text-ink">Private balances</span>
    <StatusDot label="Synced 12s ago" />
  </div>
);

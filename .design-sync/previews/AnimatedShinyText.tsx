import { AnimatedShinyText } from "pampalo";
import { RefreshCw } from "lucide-react";

// Shimmering status text — in the app it lights up the BalanceCard "Sync"
// chip while private balances are being re-derived.

export const ProofStatus = () => (
  <AnimatedShinyText className="text-ink mx-0 max-w-none text-[14px] font-medium">
    Generating shield proof for 0.42 ETH…
  </AnimatedShinyText>
);

export const SyncChip = () => (
  <span
    className="inline-flex items-center justify-center gap-1.5 h-[28px] px-3 rounded-full border border-line bg-paper-lo text-ink text-[12px] font-semibold"
  >
    <RefreshCw className="size-3.5" />
    <AnimatedShinyText className="text-ink mx-0 max-w-none">
      Syncing…
    </AnimatedShinyText>
  </span>
);

export const ShimmerWidths = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    {[
      { width: 60, label: "shimmerWidth 60" },
      { width: 100, label: "shimmerWidth 100 (default)" },
      { width: 200, label: "shimmerWidth 200" },
    ].map(({ width, label }) => (
      <div
        key={width}
        style={{ display: "flex", alignItems: "baseline", gap: 12 }}
      >
        <AnimatedShinyText
          shimmerWidth={width}
          className="text-ink mx-0 max-w-none text-[13px] font-medium"
        >
          Waiting for Base confirmation…
        </AnimatedShinyText>
        <span
          style={{
            fontSize: 11,
            color: "var(--color-ink-mute)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {label}
        </span>
      </div>
    ))}
  </div>
);

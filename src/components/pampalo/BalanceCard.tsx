import { cn } from "@/lib/utils";
import { SplitBar } from "./SplitBar";
import { SunIcon, MoonIcon } from "./SunMoonIcons";
import { SyncIndicator } from "./SyncIndicator";

type Props = {
  /** Total USD (public + private). null while loading. */
  totalUsd: number | null;
  publicUsd: number | null;
  privateUsd: number | null;
  loading?: boolean;
  className?: string;
};

function formatUsd(n: number, dp = 2): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * "Total balance" hero card. Mirrors the mockup layout: eyebrow → large
 * serif total → public/private chips → percentage caption → split bar.
 * Shows skeleton shimmer while any of the three inputs is null.
 */
export function BalanceCard({
  totalUsd,
  publicUsd,
  privateUsd,
  loading,
  className,
}: Props) {
  const isLoading =
    loading || totalUsd === null || publicUsd === null || privateUsd === null;

  const total = totalUsd ?? 0;
  const pub = publicUsd ?? 0;
  const priv = privateUsd ?? 0;
  const pubPct = total > 0 ? (pub / total) * 100 : 0;

  return (
    <section
      className={cn(
        "rounded-3xl card-cream px-5 py-5",
        "flex flex-col gap-3.5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Total Balance</p>
        <SyncIndicator />
      </div>

      {isLoading ? (
        <span
          className="skel"
          style={{ width: "60%", height: 48, borderRadius: 12 }}
        />
      ) : (
        <h1
          className="font-serif font-bold leading-[0.95] tracking-[-0.02em] text-[44px] sm:text-[52px] text-ink"
          style={{ margin: 0 }}
        >
          {formatUsd(total)}
        </h1>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="bal-chip pub">
          <SunIcon size={11} /> Public{" "}
          {isLoading ? (
            <span className="skel" style={{ width: 44, height: 11 }} />
          ) : (
            formatUsd(pub, 0)
          )}
        </span>
        <span className="bal-chip priv">
          <MoonIcon size={11} /> Private{" "}
          {isLoading ? (
            <span className="skel" style={{ width: 44, height: 11 }} />
          ) : (
            formatUsd(priv, 0)
          )}
        </span>
        {!isLoading && (
          <span className="text-[11.5px] text-ink-mute">
            {Math.round(pubPct)}% public · {Math.round(100 - pubPct)}% private
          </span>
        )}
      </div>

      <SplitBar publicValue={pub} privateValue={priv} height={8} />
    </section>
  );
}

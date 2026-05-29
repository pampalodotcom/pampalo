import { ArrowLeftRight, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { DepositButton } from "./deposit/DepositButton";
import { ReceiveButton } from "./receive/ReceiveButton";
import { SplitBar } from "./SplitBar";
import { SunIcon, MoonIcon } from "./SunMoonIcons";
// SyncIndicator (the "Sync Preferences" chip) is intentionally hidden
// for now — the underlying preferences-sync module has known bugs
// that need a rework before it should be user-visible. The hook +
// component still exist so it can be reintroduced cleanly later.

type Props = {
  /** Total USD (public + private). null while loading. */
  totalUsd: number | null;
  publicUsd: number | null;
  privateUsd: number | null;
  loading?: boolean;
  className?: string;
  /** Optional: render a top-right Swap button that calls this on click. */
  onSwap?: () => void;
  /** Optional: render a top-right Send button. Rendered to the left of
   *  Swap so the visual order matches the verb order most users expect:
   *  Send → Swap. */
  onSend?: () => void;
  /** Optional: render a Sync button that re-decrypts shield-queue notes
   *  from Convex. Stacks below Send/Swap on mobile. */
  onSync?: () => void;
  /** Whether the sync operation is currently in flight (drives the
   *  spinner + disabled state on the Sync button). */
  syncing?: boolean;
  /** Optional: render a Receive button that opens the QR-share sheet. */
  onReceive?: () => void;
  /** Optional: render the prominent Deposit CTA below the split bar. */
  onDeposit?: () => void;
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
  onSwap,
  onSend,
  onSync,
  syncing,
  onReceive,
  onDeposit,
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
      <div className="flex items-start justify-between gap-3">
        {/* Left column holds the eyebrow + balance so they stay pinned to
            the top of the row. The action buttons stack into a tall column
            on the right; keeping the balance in its own column (rather than
            a sibling row below) prevents that column's height from pushing
            the balance down and leaving a gap under the eyebrow. */}
        <div className="flex min-w-0 flex-col gap-3.5">
          <p className="eyebrow">Total Balance</p>
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
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {onSend && (
            <button
              type="button"
              onClick={onSend}
              className={cn(
                "inline-flex items-center justify-center gap-1.5",
                "h-[28px] px-3 rounded-full",
                "border border-line bg-paper-lo text-ink",
                "text-[12px] font-semibold",
                "transition-colors hover:bg-[var(--pub-soft)] hover:text-[var(--pub)]",
                "focus-visible:outline-none focus-visible:ring-3",
                "focus-visible:ring-[var(--pub-soft-2)]",
              )}
            >
              <Send className="size-3.5" />
              Send
            </button>
          )}
          {onSwap && (
            <button
              type="button"
              onClick={onSwap}
              className={cn(
                "inline-flex items-center justify-center gap-1.5",
                "h-[28px] px-3 rounded-full",
                "border border-line bg-paper-lo text-ink",
                "text-[12px] font-semibold",
                "transition-colors hover:bg-[var(--pub-soft)] hover:text-[var(--pub)]",
                "focus-visible:outline-none focus-visible:ring-3",
                "focus-visible:ring-[var(--pub-soft-2)]",
              )}
            >
              <ArrowLeftRight className="size-3.5" />
              Swap
            </button>
          )}
          {onSync && (
            <button
              type="button"
              onClick={onSync}
              disabled={syncing}
              aria-label={syncing ? "Syncing notes" : "Sync notes from Convex"}
              className={cn(
                "inline-flex items-center justify-center gap-1.5",
                "h-[28px] px-3 rounded-full",
                "border border-line bg-paper-lo text-ink",
                "text-[12px] font-semibold",
                "transition-colors hover:bg-[var(--priv-soft)] hover:text-[var(--priv)]",
                "focus-visible:outline-none focus-visible:ring-3",
                "focus-visible:ring-[var(--priv-soft-2)]",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              <RefreshCw
                className={cn("size-3.5", syncing && "animate-spin")}
              />
              {syncing ? "Syncing…" : "Sync"}
            </button>
          )}
          {/* <SyncIndicator /> — disabled: see note at top of file. */}
        </div>
      </div>

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

      {(onDeposit || onReceive) && (
        // Primary CTA row. When both are present we render them
        // side-by-side at full-width-each so they share the same
        // prominence. When only one is wired up it falls through to a
        // single full-width button (legacy single-CTA layout).
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:gap-2">
          {onDeposit && <DepositButton onClick={onDeposit} />}
          {onReceive && <ReceiveButton onClick={onReceive} />}
        </div>
      )}
    </section>
  );
}

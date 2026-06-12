import { useState } from "react";
import {
  ChevronDown,
  Clock3,
  ExternalLink,
  Moon,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { weiToNumber } from "@/lib/balances";
import { txUrl } from "@/lib/explorer";
import type { PendingNote } from "@/lib/use-private-balances";
import { NetworkChip, networkSlugForChainId } from "./NetworkChip";

/** What a queued pending shield needs to be cancelled by its shielder. */
export type CancelRequest = {
  leafCommitment: string;
  chainId: number;
  amount: bigint;
  symbol: string;
  decimals: number;
  priceUsd?: number | null;
};

// Collapsable per-asset list of pending shields shown beneath the
// SplitSlider on each AssetRow. Surfaces both buckets:
//
//   queuedNotes      — countdown to unlock
//   executableNotes  — "Finalise" CTA (actual wiring deferred —
//                       passes the note up to the parent to handle)
//
// Hidden entirely when total is zero so a fresh-balance asset doesn't
// carry empty whitespace.

type Props = {
  symbol: string;
  decimals: number;
  /** Notes still counting down to unlock. */
  queuedNotes: PendingNote[];
  /** Notes whose unlockTime has passed; user can finalise. */
  executableNotes: PendingNote[];
  /** Per-note finalise handler. Optional — when omitted the button is
   *  a no-op placeholder; the cleaner UX path is to wire to a confirm
   *  sheet at the wallet level. */
  onFinalise?: (note: PendingNote) => void;
  /** Cancel a still-queued shield (refunds the shielder). Wired to a
   *  confirm sheet at the wallet level. */
  onCancel?: (req: CancelRequest) => void;
  /** USD price per whole token, for the per-row USD value. */
  priceUsd?: number | null;
  /** Roughly how many display digits to show for the amount column. */
  roundTo?: number;
};

const DEFAULT_ROUND_TO: Partial<Record<string, number>> = {
  ETH: 5,
  USDC: 2,
  AUDD: 2,
};

export function PendingShieldsList({
  symbol,
  decimals,
  queuedNotes,
  executableNotes,
  onFinalise,
  onCancel,
  priceUsd,
  roundTo,
}: Props) {
  const usdFor = (amount: bigint): string | null => {
    if (priceUsd == null) return null;
    const usd = weiToNumber(amount, decimals) * priceUsd;
    return usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
  };
  const [open, setOpen] = useState(false);
  const total = queuedNotes.length + executableNotes.length;
  if (total === 0) return null;

  const dp = roundTo ?? DEFAULT_ROUND_TO[symbol] ?? 4;
  const readyCount = executableNotes.length;

  return (
    <div className="mt-3 rounded-2xl border border-line bg-paper-lo">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3.5 py-2.5",
          "text-left text-[12.5px] text-ink-soft",
          "transition-colors hover:bg-paper-lo/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
          "rounded-2xl",
        )}
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <Moon className="size-3.5 text-[var(--priv)]" aria-hidden />
          <span className="font-semibold text-ink">
            {total} pending shield{total === 1 ? "" : "s"}
          </span>
          {readyCount > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                "bg-[var(--priv-soft)] text-[var(--priv)]",
                "text-[10.5px] font-semibold uppercase tracking-[0.08em]",
              )}
            >
              <Sparkles className="size-3" aria-hidden />
              {readyCount} ready
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-ink-mute transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <ul className="flex flex-col gap-1 border-t border-line px-2 py-2">
          {executableNotes.map((n) => (
            <li
              key={`exec-${n.leafCommitment}`}
              className={cn(
                "flex items-center justify-between gap-2 rounded-xl px-2 py-1.5",
                "bg-[var(--priv-soft)]/40",
              )}
            >
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink">
                <Sparkles className="size-3.5 text-[var(--priv)]" aria-hidden />
                <span className="font-mono font-semibold">
                  {fmtAmount(n.amount, decimals, dp)} {symbol}
                </span>
                {usdFor(n.amount) && (
                  <span className="text-[11px] text-ink-mute">
                    {usdFor(n.amount)}
                  </span>
                )}
                <NetworkBadge chainId={n.chainId} />
                <span className="text-[11px] text-ink-mute">
                  ready to finalise
                </span>
                <ExplorerLink note={n} />
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5">
                {onCancel && (
                  <button
                    type="button"
                    onClick={() =>
                      onCancel({
                        leafCommitment: n.leafCommitment,
                        chainId: n.chainId,
                        amount: n.amount,
                        symbol,
                        decimals,
                        priceUsd: priceUsd ?? null,
                      })
                    }
                    className={cn(
                      "inline-flex h-7 items-center rounded-full px-3",
                      "border border-line bg-paper text-[11.5px] font-semibold text-ink",
                      "transition-colors hover:bg-paper-lo",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
                    )}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onFinalise?.(n)}
                  disabled={!onFinalise}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full px-3",
                    "bg-[var(--priv)] text-white text-[11.5px] font-semibold",
                    "transition-opacity hover:opacity-90",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  Finalise
                </button>
              </span>
            </li>
          ))}
          {queuedNotes.map((n) => (
            <li
              key={`queued-${n.leafCommitment}`}
              className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-2 py-1.5"
            >
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink">
                <Clock3 className="size-3.5 text-ink-mute" aria-hidden />
                <span className="font-mono">
                  {fmtAmount(n.amount, decimals, dp)} {symbol}
                </span>
                {usdFor(n.amount) && (
                  <span className="text-[11px] text-ink-mute">
                    {usdFor(n.amount)}
                  </span>
                )}
                <NetworkBadge chainId={n.chainId} />
                <ExplorerLink note={n} />
              </span>
              <span className="inline-flex shrink-0 items-center gap-2">
                <span className="font-mono text-[11px] text-ink-mute">
                  unlocks {countdownLabel(n.unlockTime)}
                </span>
                {onCancel && (
                  <button
                    type="button"
                    onClick={() =>
                      onCancel({
                        leafCommitment: n.leafCommitment,
                        chainId: n.chainId,
                        amount: n.amount,
                        symbol,
                        decimals,
                        priceUsd: priceUsd ?? null,
                      })
                    }
                    className={cn(
                      "inline-flex h-7 items-center rounded-full px-3",
                      "border border-line bg-paper text-[11.5px] font-semibold text-ink",
                      "transition-colors hover:bg-paper-lo",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
                    )}
                  >
                    Cancel
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExplorerLink({ note }: { note: PendingNote }) {
  if (!note.queuedTxHash) return null;
  const url = txUrl(note.chainId, note.queuedTxHash);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="View shield tx on block explorer"
      aria-label="View shield tx on block explorer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded",
        "text-ink-mute transition-colors hover:bg-paper-lo hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
      )}
    >
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

function NetworkBadge({ chainId }: { chainId: number }) {
  const slug = networkSlugForChainId(chainId);
  if (!slug) return null;
  return <NetworkChip network={slug} />;
}

function fmtAmount(wei: bigint, decimals: number, dp: number): string {
  const n = weiToNumber(wei, decimals);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function countdownLabel(unlockTimeSec: number): string {
  const delta = unlockTimeSec * 1000 - Date.now();
  if (delta <= 0) return "now";
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

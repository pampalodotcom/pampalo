import { useMemo } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared gas-tier picker used by ReviewSwap and SendModal. Owns the
// expand/collapse chrome and the per-tier USD/gwei math; takes the
// cached gas price + (optional) gas units + ETH/USD as inputs so the
// caller doesn't need to repeat the bigint→Number staging.
//
// The tier multiplier ladder absorbs both the up-to-60s staleness of
// the `latestGas` cron data and the user's "I want it now" preference.
// See ADR 0004 for why we use the cached cron data rather than a fresh
// fetch.

export type GasTier = "slower" | "standard" | "faster" | "stupid";

export const GAS_TIERS: ReadonlyArray<GasTier> = [
  "slower",
  "standard",
  "faster",
  "stupid",
];

// Multipliers applied to the cached gasPriceWei. Self-explanatory at
// the extremes; standard = exactly what the gas cron last observed,
// "stupid fast" is the "I'd rather burn dollars than wait" tier.
export const GAS_TIER_MULTIPLIER: Record<GasTier, number> = {
  slower: 0.85,
  standard: 1.0,
  faster: 1.4,
  stupid: 2.2,
};

const TIER_LABEL: Record<GasTier, string> = {
  slower: "Slower",
  standard: "Standard",
  faster: "Faster",
  stupid: "Stupid fast",
};

const TIER_HINT: Record<GasTier, string> = {
  slower: "may take a few blocks",
  standard: "current network rate",
  faster: "priority bump",
  stupid: "next-block, no questions asked",
};

/** Scale a bigint by a 2-dp multiplier (e.g. 1.4 → ×140/100) while
 *  keeping bigint precision. Exported for callers that need the same
 *  scaling at sign-time so the user pays exactly what the picker
 *  showed. */
export function scaleByTier(value: bigint, tier: GasTier): bigint {
  const m = GAS_TIER_MULTIPLIER[tier];
  return (value * BigInt(Math.round(m * 100))) / 100n;
}

type TierFigures = { gweiPerUnit: number | null; usd: number | null };

export function GasTierPicker({
  tier,
  onTierChange,
  open,
  onToggle,
  gasPriceWei,
  gasUnits,
  ethUsdPrice,
}: {
  tier: GasTier;
  onTierChange: (next: GasTier) => void;
  /** When `open` is undefined, the picker renders permanently expanded
   *  (no header chevron). Pass both `open` + `onToggle` for the
   *  collapsed-by-default chrome ReviewSwap uses. */
  open?: boolean;
  onToggle?: () => void;
  /** Cached gas-price from `api.prices.gas.latestForChain`. null while loading. */
  gasPriceWei: string | null | undefined;
  /** Gas-units estimate for the tx the user is about to sign. When
   *  unknown, USD column shows "—" but gwei still renders. */
  gasUnits: bigint | null;
  /** USD per ETH from `api.prices.feeds.listLatest`. null while loading. */
  ethUsdPrice: number | null;
}) {
  const figures = useMemo<Record<GasTier, TierFigures>>(() => {
    const empty: TierFigures = { gweiPerUnit: null, usd: null };
    const out: Record<GasTier, TierFigures> = {
      slower: { ...empty },
      standard: { ...empty },
      faster: { ...empty },
      stupid: { ...empty },
    };
    if (!gasPriceWei) return out;
    const basePriceWei = BigInt(gasPriceWei);
    if (basePriceWei <= 0n) return out;

    for (const t of GAS_TIERS) {
      const scaledWei = scaleByTier(basePriceWei, t);
      // Convert to gwei via Number. Even on the worst real chain
      // (mainnet at 1000 gwei × 2.2) this stays well under 2^53.
      out[t].gweiPerUnit = Number(scaledWei) / 1e9;
      if (gasUnits === null || ethUsdPrice === null) continue;
      // Divide-first via gwei to keep Number in safe range under the
      // 2.2× multiplier at congestion peak.
      const totalGwei = (gasUnits * scaledWei) / 1_000_000_000n;
      const ethCost = Number(totalGwei) / 1e9;
      out[t].usd = ethCost * ethUsdPrice;
    }
    return out;
  }, [gasPriceWei, gasUnits, ethUsdPrice]);

  const selectedUsd = figures[tier].usd;
  const collapsible = open !== undefined && onToggle !== undefined;

  // When rendered inline (no collapsible chrome), just show the tier list.
  if (!collapsible) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Network fee
        </p>
        <TierList
          tier={tier}
          onTierChange={onTierChange}
          figures={figures}
          gasPriceWei={gasPriceWei}
        />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-muted/30">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5">
          {open ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          )}
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Network fee
          </span>
          {!open && (
            <span className="text-[12px] font-medium text-ink">
              {TIER_LABEL[tier]}
            </span>
          )}
        </span>
        {!open && (
          <span className="flex flex-col items-end leading-tight">
            <span className="font-mono text-[12px] text-ink">
              {selectedUsd !== null ? `≈ ${fmtUsd(selectedUsd)}` : "—"}
            </span>
            <span className="font-mono text-[10px] text-ink-mute">
              {figures[tier].gweiPerUnit !== null
                ? `${formatGwei(figures[tier].gweiPerUnit)} gwei`
                : !gasPriceWei
                  ? "estimating…"
                  : "—"}
            </span>
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          {!gasPriceWei && (
            <p className="mb-1.5 text-right text-[10px] text-muted-foreground">
              Estimating gas…
            </p>
          )}
          <TierList
            tier={tier}
            onTierChange={onTierChange}
            figures={figures}
            gasPriceWei={gasPriceWei}
          />
        </div>
      )}
    </div>
  );
}

function TierList({
  tier,
  onTierChange,
  figures,
  gasPriceWei,
}: {
  tier: GasTier;
  onTierChange: (next: GasTier) => void;
  figures: Record<GasTier, TierFigures>;
  gasPriceWei: string | null | undefined;
}) {
  return (
    <>
      {!gasPriceWei && (
        <p className="mb-1.5 text-right text-[10px] text-muted-foreground">
          Estimating gas…
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {GAS_TIERS.map((t) => (
          <li key={t}>
            <TierRow
              tier={t}
              selected={t === tier}
              gweiPerUnit={figures[t].gweiPerUnit}
              usd={figures[t].usd}
              onSelect={() => onTierChange(t)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function TierRow({
  tier,
  selected,
  gweiPerUnit,
  usd,
  onSelect,
}: {
  tier: GasTier;
  selected: boolean;
  gweiPerUnit: number | null;
  usd: number | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm",
        "transition-colors",
        selected
          ? "bg-primary/10 ring-1 ring-primary/20"
          : "hover:bg-foreground/5",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-full border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background",
          )}
        >
          {selected && <Check className="size-2.5" />}
        </span>
        <span className="font-medium text-ink">{TIER_LABEL[tier]}</span>
        <span className="text-[10.5px] text-ink-mute">{TIER_HINT[tier]}</span>
      </span>
      <span className="flex flex-col items-end leading-tight">
        <span className="font-mono text-xs text-ink">
          {usd === null ? "—" : `≈ ${fmtUsd(usd)}`}
        </span>
        <span className="font-mono text-[10px] text-ink-mute">
          {gweiPerUnit === null ? "—" : `${formatGwei(gweiPerUnit)} gwei`}
        </span>
      </span>
    </button>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 0.01 ? 4 : 2,
    maximumFractionDigits: n < 0.01 ? 4 : 2,
  });
}

// Gwei display rounds adaptively: chains like Ethereum sit around tens
// of gwei (whole-number is fine); Base / Arbitrum sit at fractions of
// a gwei (need 2-3 dp to actually be informative).
function formatGwei(gwei: number): string {
  if (gwei >= 1) return gwei.toFixed(1);
  if (gwei >= 0.01) return gwei.toFixed(3);
  return gwei.toExponential(2);
}

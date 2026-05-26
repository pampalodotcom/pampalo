import { useState } from "react";
import { ArrowDown, ArrowLeft } from "lucide-react";
import { weiToNumber } from "@/lib/balances";
import { applySlippageMax, applySlippageMin } from "@/lib/uniswap-swap";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AssetMark } from "./AssetMark";
import { type TokenPair } from "./AssetSelect";
import {
  GasTierPicker,
  GAS_TIER_MULTIPLIER,
  type GasTier,
} from "./GasTierPicker";
import {
  NetworkChip,
  networkSlugForChainId,
  type NetworkSlug,
} from "./NetworkChip";

// Review-stage pane: shows the user exactly what they're about to
// commit (tokens, networks, USD values), the route they'll execute,
// and a gas-tier selector with live USD-cost previews per tier.
// Receives all data via props — owns nothing except the selected
// tier so the user can back out without losing other modal state.
// Tier picker chrome (slower/standard/faster/stupid + multiplier math)
// lives in GasTierPicker so the SendModal review pane can reuse it.

export type { GasTier } from "./GasTierPicker";

type PriceRow = {
  shortId: string;
  answer: string;
  feedDecimals: number;
};

type GasReading = {
  gasPriceWei: string;
};

type Quote = {
  version: "v2" | "v3";
  fee?: number;
  amountIn: string | null;
  amountOut: string | null;
  gasEstimateUnits: string | null;
};

// Default slippage tolerance, basis points. 0.5% matches Uniswap UI's
// default — strict enough that MEV bots can't drain a meaningful slice
// of the swap, loose enough that normal price movement between
// quote-time and inclusion-time doesn't revert. The wallet's existing
// `applySlippageMin`/`applySlippageMax` helpers translate this into
// the Router's `amountOutMinimum` / `amountInMaximum` parameter, which
// the Uniswap Router enforces atomically: if the swap would deliver
// less (or take more) than the limit, the on-chain call reverts and
// the user keeps their input. No "you got rugged" surprise.
const DEFAULT_SLIPPAGE_BPS = 50;

export function ReviewSwap({
  tokenIn,
  tokenOut,
  quote,
  kind,
  prices,
  gas,
  onBack,
  onConfirm,
}: {
  tokenIn: TokenPair;
  tokenOut: TokenPair;
  /** The best quote from the picker stage. Must be `available` —
   *  caller gates this. */
  quote: Quote;
  /** Which side the user typed — drives the slippage-protection
   *  display ("minimum received" for exactIn, "maximum sent" for
   *  exactOut). */
  kind: "exactIn" | "exactOut";
  prices: PriceRow[] | undefined;
  gas: GasReading | null | undefined;
  onBack: () => void;
  onConfirm: (tier: GasTier) => void;
}) {
  const [tier, setTier] = useState<GasTier>("standard");
  // Collapsed by default: most users don't change gas tier, and the
  // 4-row picker adds significant vertical real estate. Expand only
  // when they actually want to tune.
  const [feeOpen, setFeeOpen] = useState(false);

  // ── USD price lookups ────────────────────────────────────────────────
  function usdPriceFor(token: TokenPair): number | null {
    if (!token.priceFeedShortId) return 1; // stables default
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === token.priceFeedShortId);
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  }
  const ethUsdPrice = (() => {
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  })();

  // ── Side breakdowns ──────────────────────────────────────────────────
  const payAmount =
    quote.amountIn !== null
      ? weiToNumber(BigInt(quote.amountIn), tokenIn.decimals)
      : null;
  const receiveAmount =
    quote.amountOut !== null
      ? weiToNumber(BigInt(quote.amountOut), tokenOut.decimals)
      : null;
  const payUsd =
    payAmount !== null
      ? (() => {
          const p = usdPriceFor(tokenIn);
          return p === null ? null : payAmount * p;
        })()
      : null;
  const receiveUsd =
    receiveAmount !== null
      ? (() => {
          const p = usdPriceFor(tokenOut);
          return p === null ? null : receiveAmount * p;
        })()
      : null;

  // Per-tier gas math lives in GasTierPicker. We still need the
  // *selected*-tier USD for the cost-breakdown rows below, so recompute
  // it locally — same formula as the picker but only for the active
  // tier, to keep this component a thin caller.
  const gasUnits = quote.gasEstimateUnits
    ? BigInt(quote.gasEstimateUnits)
    : null;
  const selectedGasUsd = (() => {
    if (!gas?.gasPriceWei || gasUnits === null || ethUsdPrice === null) {
      return null;
    }
    const base = BigInt(gas.gasPriceWei);
    const scaled =
      (base * BigInt(Math.round(GAS_TIER_MULTIPLIER[tier] * 100))) / 100n;
    const totalGwei = (gasUnits * scaled) / 1_000_000_000n;
    return (Number(totalGwei) / 1e9) * ethUsdPrice;
  })();
  // Total cost falls back to just the pay-side USD when gas isn't
  // available yet — better than rendering "—" for the headline number.
  const totalCostUsd =
    payUsd !== null ? payUsd + (selectedGasUsd ?? 0) : null;

  // ── Slippage-floor / ceiling ────────────────────────────────────────
  // The Uniswap Router enforces `amountOutMinimum` (exactIn) or
  // `amountInMaximum` (exactOut) atomically: the swap reverts if the
  // pool can't honour the limit. We pick 0.5% by default (matches
  // Uniswap UI). When confirm wiring lands, this same value feeds
  // straight into buildV2SwapTx / buildV3SwapTx's `amountLimit`.
  const protection = (() => {
    if (kind === "exactIn") {
      if (!quote.amountOut) return null;
      const minOutWei = applySlippageMin(
        BigInt(quote.amountOut),
        DEFAULT_SLIPPAGE_BPS,
      );
      const amount = weiToNumber(minOutWei, tokenOut.decimals);
      return {
        label: "Minimum received",
        value: `${formatAmount(amount, tokenOut.decimals)} ${tokenOut.symbol}`,
      };
    }
    if (!quote.amountIn) return null;
    const maxInWei = applySlippageMax(
      BigInt(quote.amountIn),
      DEFAULT_SLIPPAGE_BPS,
    );
    const amount = weiToNumber(maxInWei, tokenIn.decimals);
    return {
      label: "Maximum sent",
      value: `${formatAmount(amount, tokenIn.decimals)} ${tokenIn.symbol}`,
    };
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-mute hover:text-ink-soft"
        >
          <ArrowLeft className="size-4" />
          Edit
        </button>
      </div>

      {/* Send / receive cards */}
      <div className="flex flex-col gap-2">
        <SideSummary
          label="You pay"
          token={tokenIn}
          amount={payAmount}
          usd={payUsd}
        />
        <div className="flex justify-center">
          <span className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
            <ArrowDown className="size-3.5" />
          </span>
        </div>
        <SideSummary
          label="You receive (estimate)"
          token={tokenOut}
          amount={receiveAmount}
          usd={receiveUsd}
        />
      </div>

      {/* Slippage-protection floor / ceiling. Tooltip explains the
          atomic-revert guarantee. */}
      {protection && (
        <TooltipProvider delayDuration={200}>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {protection.label}
                  <span className="ml-1 normal-case tracking-normal text-[10px] text-muted-foreground/60">
                    ({DEFAULT_SLIPPAGE_BPS / 100}% slippage)
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {kind === "exactIn"
                  ? "If the swap can't deliver at least this much, the on-chain transaction reverts and you keep your input."
                  : "If the swap would cost more than this, the on-chain transaction reverts and you keep your input."}
              </TooltipContent>
            </Tooltip>
            <span className="font-mono text-[12px] text-ink">
              {protection.value}
            </span>
          </div>
        </TooltipProvider>
      )}

      {/* Route */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Route
        </span>
        <RouteBadge quote={quote} />
      </div>

      {/* Gas tier picker — collapsed by default. Header summarises
          the current pick + cost; expanding reveals the full
          slower/standard/faster/stupid menu. */}
      <GasTierPicker
        tier={tier}
        onTierChange={setTier}
        open={feeOpen}
        onToggle={() => setFeeOpen((o) => !o)}
        gasPriceWei={gas?.gasPriceWei ?? null}
        gasUnits={gasUnits}
        ethUsdPrice={ethUsdPrice}
      />

      {/* Cost breakdown — separates the asset value the user is
          actually spending from the network fee they'll pay on top.
          Same total as before; just made the composition visible. */}
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-[13px]">
        <div className="flex items-center justify-between text-ink-soft">
          <span>Asset sent value</span>
          <span className="font-mono">
            {payUsd !== null ? fmtUsd(payUsd) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between text-ink-soft">
          <span>Network fee</span>
          <span className="font-mono">
            {selectedGasUsd !== null ? fmtUsd(selectedGasUsd) : "—"}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between border-t border-border/60 pt-1.5 font-semibold text-ink">
          <span>Total cost</span>
          <span className="font-mono">
            {totalCostUsd !== null ? fmtUsd(totalCostUsd) : "—"}
          </span>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <p className="text-[11px] font-medium text-ink-mute">
          Swaps coming very soon
        </p>
        <Button
          type="button"
          disabled
          className="w-full"
          // The handler stays wired for when we re-enable; right now
          // the disabled state means it never fires.
          onClick={() => onConfirm(tier)}
        >
          Confirm swap
        </Button>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────

function SideSummary({
  label,
  token,
  amount,
  usd,
}: {
  label: string;
  token: TokenPair;
  amount: number | null;
  usd: number | null;
}) {
  const slug = networkSlugForChainId(token.chainId);
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex items-center gap-3">
        <span className="relative">
          <AssetMark symbol={token.symbol} size={36} />
          {slug && (
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border border-popover"
              style={{ background: chainDot(slug) }}
            />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[20px] font-semibold text-ink">
            {amount !== null
              ? `${formatAmount(amount, token.decimals)} ${token.symbol}`
              : `— ${token.symbol}`}
          </span>
          <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
            {slug && <NetworkChip network={slug} />}
            {usd !== null && (
              <span className="font-mono">≈ {fmtUsd(usd)}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

const UNI_PINK = "#ff007a";

function RouteBadge({ quote }: { quote: Quote }) {
  const feePct = quote.version === "v2" ? 0.3 : (quote.fee ?? 0) / 10_000;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
        style={{ background: `${UNI_PINK}1a`, color: UNI_PINK }}
      >
        UNI {quote.version}
      </span>
      <span
        className="rounded-md px-1.5 py-0.5 text-[10px] font-mono font-semibold"
        style={{ background: `${UNI_PINK}10`, color: UNI_PINK }}
      >
        {feePct.toFixed(2)}%
      </span>
    </span>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function chainDot(slug: NetworkSlug): string {
  if (slug === "base") return "#0052FF";
  if (slug === "eth") return "#627EEA";
  return "currentColor";
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 0.01 ? 4 : 2,
    maximumFractionDigits: n < 0.01 ? 4 : 2,
  });
}

function formatAmount(n: number, decimals: number): string {
  const maxDp = decimals === 18 ? 6 : 4;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDp,
    useGrouping: false,
  });
}

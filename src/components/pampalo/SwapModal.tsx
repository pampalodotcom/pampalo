import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAction, useQuery } from "convex/react";
import { ArrowDownUp, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { parseUnits } from "ethers";
import { api } from "../../../convex/_generated/api";
import { weiToNumber } from "@/lib/balances";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  BalanceTiles,
  ChainPeerTiles,
  TokenDropdown,
  TokenSelectButton,
  type TokenPair,
} from "./AssetSelect";
import { NetworkChip, networkSlugForChainId } from "./NetworkChip";
import { ReviewSwap } from "./ReviewSwap";

// Chains where we have Uniswap support wired up server-side (see
// `UNISWAP_ADDRESSES` in convex/uniswap.ts). Anything outside this set
// is hidden from the picker — the convex action would throw and the
// user would have no path to a liquid pool.
const SWAP_CHAIN_IDS = new Set([1, 8453]);

type PriceRow = {
  shortId: string;
  answer: string;
  feedDecimals: number;
};

type Kind = "exactIn" | "exactOut";

type QuoteOption = {
  version: "v2" | "v3";
  fee?: number;
  poolAddress: string | null;
  amountIn: string | null;
  amountOut: string | null;
  /** Gas units to execute this swap (decimal string). null when the
   *  option is unavailable. */
  gasEstimateUnits: string | null;
  available: boolean;
  error?: string;
};

// USD per whole unit of `token`. Mirrors the helper in wallet.tsx:
// stables without a feed (USDC) → $1; anything with a feed reads
// `base/usd` and so the answer is already USD per whole token.
function usdPriceFor(
  token: TokenPair | null,
  prices: PriceRow[] | undefined,
): number | null {
  if (!token) return null;
  if (!token.priceFeedShortId) return 1; // USDC default
  if (!prices) return null;
  const feed = prices.find((p) => p.shortId === token.priceFeedShortId);
  if (!feed) return null;
  return Number(feed.answer) / 10 ** feed.feedDecimals;
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Display formatting for token amounts. Cap fractional digits so
// 0.49805123… doesn't blow out the input width. ETH-decimals → 6 dp,
// stables → 4 dp.
function formatAmount(n: number, decimals: number): string {
  const maxDp = decimals === 18 ? 6 : 4;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDp,
    useGrouping: false,
  });
}

export function SwapModal({
  open,
  onOpenChange,
  evmAddress,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** User's EVM address — needed by the asset picker to show live balances. */
  evmAddress: string;
}) {
  const tokensRaw = useQuery(api.tokens.list, {});
  const prices = useQuery(api.prices.listLatest, {});

  // Flatten the catalogue into (token, chain) pairs the picker can
  // render. Memoised so the picker's per-row balance hooks see the
  // same identity across renders.
  const pairs = useMemo<TokenPair[] | null>(() => {
    if (!tokensRaw) return null;
    return tokensRaw
      .filter((t) => SWAP_CHAIN_IDS.has(t.chainId))
      .map(
        (t): TokenPair => ({
          symbol: t.symbol,
          name: t.name,
          chainId: t.chainId,
          address: t.address,
          decimals: t.decimals,
          priceFeedShortId: t.priceFeedShortId,
        }),
      );
  }, [tokensRaw]);

  // Selection state. Each side starts unset — the user picks.
  const [tokenIn, setTokenIn] = useState<TokenPair | null>(null);
  const [tokenOut, setTokenOut] = useState<TokenPair | null>(null);
  const [kind, setKind] = useState<Kind>("exactIn");
  const [rawAmount, setRawAmount] = useState("");
  // One picker open at a time — null when both closed.
  const [openPicker, setOpenPicker] = useState<"in" | "out" | null>(null);
  // 'quote' = pick tokens + see live quotes. 'review' = confirm
  // pane with route / gas-tier picker / total cost. Only reachable
  // when a best quote exists.
  const [phase, setPhase] = useState<"quote" | "review">("quote");

  // Reset to the quote pane whenever the modal closes — otherwise a
  // user who opens swap → review → closes → reopens lands back on
  // the Review pane with stale numbers.
  useEffect(() => {
    if (!open) setPhase("quote");
  }, [open]);

  const inputSideToken = kind === "exactIn" ? tokenIn : tokenOut;

  // Active chain = whichever side is set. Either works since the
  // picker / pickIn / pickOut enforce same-chain swaps. Used to drive
  // the gas-cron subscription that powers the network-fee USD line
  // below the Available Quotes list.
  const activeChainId = tokenIn?.chainId ?? tokenOut?.chainId ?? null;
  const gas = useQuery(
    api.gas.latestForChain,
    activeChainId !== null ? { chainId: activeChainId } : "skip",
  );

  const getAllQuotes = useAction(api.uniswap.getAllQuotes);
  const [quotes, setQuotes] = useState<QuoteOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the user picks a token on a different chain than the OTHER
  // side already had selected, try to keep the swap same-chain by
  // switching the counterpart to the matching symbol on the new
  // chain. If no match exists, clear it and let the user re-pick.
  // `null` clears this side (via the dropdown header's Clear button).
  function pickIn(next: TokenPair | null) {
    setTokenIn(next);
    setQuotes(null);
    if (next && tokenOut && tokenOut.chainId !== next.chainId) {
      const match = pairs?.find(
        (p) => p.symbol === tokenOut.symbol && p.chainId === next.chainId,
      );
      setTokenOut(match ?? null);
    }
  }
  function pickOut(next: TokenPair | null) {
    setTokenOut(next);
    setQuotes(null);
    if (next && tokenIn && tokenIn.chainId !== next.chainId) {
      const match = pairs?.find(
        (p) => p.symbol === tokenIn.symbol && p.chainId === next.chainId,
      );
      setTokenIn(match ?? null);
    }
  }

  // Debounced quote fetch. The cancel flag is declared at effect scope
  // so the cleanup can flip it and any in-flight async work bails out
  // before touching React state.
  useEffect(() => {
    if (!open || !tokenIn || !tokenOut || !inputSideToken) return;
    if (tokenIn.chainId !== tokenOut.chainId) return;
    if (
      tokenIn.symbol === tokenOut.symbol &&
      tokenIn.chainId === tokenOut.chainId
    ) {
      return;
    }
    let parsed: bigint;
    try {
      parsed = parseUnits(rawAmount || "0", inputSideToken.decimals);
    } catch {
      setError("Invalid amount");
      setQuotes(null);
      return;
    }
    if (parsed <= 0n) {
      setQuotes(null);
      setError(null);
      return;
    }
    setError(null);
    setLoading(true);

    const cancelled = { current: false };
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const result = await getAllQuotes({
            chainId: tokenIn.chainId,
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            kind,
            amount: parsed.toString(),
          });
          if (cancelled.current) return;
          setQuotes(result.options);
        } catch (e) {
          if (cancelled.current) return;
          setError(e instanceof Error ? e.message : "Quote failed");
          setQuotes(null);
        } finally {
          if (!cancelled.current) setLoading(false);
        }
      })();
    }, 250);

    return () => {
      cancelled.current = true;
      clearTimeout(handle);
      setLoading(false);
    };
  }, [
    open,
    rawAmount,
    kind,
    tokenIn,
    tokenOut,
    inputSideToken,
    getAllQuotes,
  ]);

  // Sort: best (most-out for exactIn, least-in for exactOut) first;
  // unavailable last.
  const sortedQuotes = useMemo(() => {
    if (!quotes) return null;
    const copy = quotes.slice();
    copy.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (!a.available) return 0;
      const av = BigInt(
        (kind === "exactIn" ? a.amountOut : a.amountIn) ?? "0",
      );
      const bv = BigInt(
        (kind === "exactIn" ? b.amountOut : b.amountIn) ?? "0",
      );
      if (kind === "exactIn") return av > bv ? -1 : av < bv ? 1 : 0;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    return copy;
  }, [quotes, kind]);

  const best = sortedQuotes?.find((q) => q.available) ?? null;

  // The non-editable side reflects the best quote.
  const counterAmountDisplay = (() => {
    if (!best || !tokenIn || !tokenOut) return "";
    const wei =
      kind === "exactIn" ? best.amountOut ?? "0" : best.amountIn ?? "0";
    const decimals =
      kind === "exactIn" ? tokenOut.decimals : tokenIn.decimals;
    const n = weiToNumber(BigInt(wei), decimals);
    return formatAmount(n, decimals);
  })();

  function usdFor(amountStr: string, token: TokenPair | null): number | null {
    if (!token) return null;
    const price = usdPriceFor(token, prices ?? undefined);
    if (price === null) return null;
    let parsed: bigint;
    try {
      parsed = parseUnits(amountStr || "0", token.decimals);
    } catch {
      return null;
    }
    if (parsed === 0n) return 0;
    return weiToNumber(parsed, token.decimals) * price;
  }

  const topAmountStr = kind === "exactIn" ? rawAmount : counterAmountDisplay;
  const bottomAmountStr =
    kind === "exactOut" ? rawAmount : counterAmountDisplay;
  const topUsd = usdFor(topAmountStr, tokenIn);
  const bottomUsd = usdFor(bottomAmountStr, tokenOut);

  // Network-fee estimate for the picked quote, in USD. Pulls from data
  // already streamed in by the crons + chainlink:
  //   gasEstimateUnits (per option, returned by getAllQuotes — for v3
  //     it's the QuoterV2's own estimate; for v2 it's a hardcoded
  //     typical of 150k)
  //   gasPriceWei      (latestGas, refreshed every minute by the gas
  //     cron — see convex/gas.ts)
  //   eth/usd          (latestPrices, refreshed every 30s by the
  //     prices cron — see convex/prices.ts)
  // No extra RPC. Returns null while any input is still loading or if
  // the picked quote has no gasEstimateUnits (only happens for the
  // "unavailable" rows, which the best-quote selection skips anyway).
  const ethUsdPrice = (() => {
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  })();
  const bestGasUsd = (() => {
    if (!best?.gasEstimateUnits || !gas?.gasPriceWei || ethUsdPrice === null) {
      return null;
    }
    const gasUnits = BigInt(best.gasEstimateUnits);
    const gasPriceWei = BigInt(gas.gasPriceWei);
    // Divide-first via gwei to keep the Number in safe range — at
    // mainnet peak (200k × 1000 gwei = 2e17 wei) the raw wei product
    // overflows Number's 2^53 ceiling; gwei units stay comfortably
    // small (200k gwei in that worst case).
    const totalGwei = (gasUnits * gasPriceWei) / 1_000_000_000n;
    const ethCost = Number(totalGwei) / 1e9;
    return ethCost * ethUsdPrice;
  })();

  function onFlip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setQuotes(null);
  }

  const sameSelection =
    tokenIn !== null &&
    tokenOut !== null &&
    tokenIn.symbol === tokenOut.symbol &&
    tokenIn.chainId === tokenOut.chainId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">
            {phase === "review" ? "Review swap" : "Swap"}
          </DialogTitle>
        </DialogHeader>

        {!pairs ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : phase === "review" && tokenIn && tokenOut && best ? (
          <ReviewSwap
            tokenIn={tokenIn}
            tokenOut={tokenOut}
            quote={best}
            kind={kind}
            prices={prices ?? undefined}
            gas={gas}
            onBack={() => setPhase("quote")}
            onConfirm={() => {
              // Confirm is disabled (swaps coming soon); this
              // handler stays wired for when we re-enable.
              setPhase("quote");
            }}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <SideBox
              label={kind === "exactIn" ? "You pay" : "You pay (max)"}
              token={tokenIn}
              counterpart={tokenOut}
              pairs={pairs}
              evmAddress={evmAddress}
              prices={prices ?? undefined}
              pickerOpen={openPicker === "in"}
              onPickerOpen={(o) => setOpenPicker(o ? "in" : null)}
              onTokenChange={pickIn}
              value={topAmountStr}
              editable={kind === "exactIn"}
              onValueChange={(v) => {
                setKind("exactIn");
                setRawAmount(v);
              }}
              usdValue={topUsd}
              // Pay-side dropdown lands on "My tokens" so the user
              // sees their balances immediately. Receive-side keeps
              // the "All" default since you may want to acquire
              // something you don't currently hold.
              pickerDefaultFilter="mine"
              footer={
                // Quick-pick tiles for tokens the user already holds.
                // Rendered right-aligned under the trigger pill so the
                // visual line is: pill → tiles. Hides itself when the
                // user has no balances on the allowed chain.
                <BalanceTiles
                  pairs={pairs}
                  evmAddress={evmAddress}
                  selected={tokenIn}
                  counterpart={tokenOut}
                  onSelect={pickIn}
                />
              }
            />

            <div className="flex justify-center">
              <button
                type="button"
                onClick={onFlip}
                className={cn(
                  "inline-flex size-8 items-center justify-center",
                  "rounded-full border border-border bg-background",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                aria-label="Swap direction"
              >
                <ArrowDownUp className="size-3.5" />
              </button>
            </div>

            <SideBox
              label={
                kind === "exactOut" ? "You receive" : "You receive (estimate)"
              }
              token={tokenOut}
              counterpart={tokenIn}
              pairs={pairs}
              evmAddress={evmAddress}
              prices={prices ?? undefined}
              pickerOpen={openPicker === "out"}
              onPickerOpen={(o) => setOpenPicker(o ? "out" : null)}
              onTokenChange={pickOut}
              value={bottomAmountStr}
              editable={kind === "exactOut"}
              onValueChange={(v) => {
                setKind("exactOut");
                setRawAmount(v);
              }}
              usdValue={bottomUsd}
              footer={
                // Receive-side tiles. Bidirectional with the pay
                // side: each row uses the OTHER side as a chain
                // anchor. When tokenIn is null, no chain restriction
                // — every swap-catalog token shows as a quick-pick,
                // and tapping one auto-restricts the pay side to the
                // same chain via `pickOut`.
                <ChainPeerTiles
                  pairs={pairs}
                  selected={tokenOut}
                  counterpart={tokenIn}
                  onSelect={pickOut}
                />
              }
            />

            {sameSelection && (
              <p className="text-xs text-destructive">
                Pick two different tokens.
              </p>
            )}

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            <QuoteList
              quotes={sortedQuotes}
              loading={loading}
              kind={kind}
              tokenIn={tokenIn}
              tokenOut={tokenOut}
              networkFeeUsd={bestGasUsd}
            />

            <Button
              type="button"
              disabled={!best || sameSelection || loading}
              className="mt-1 w-full"
              variant="default"
              onClick={() => setPhase("review")}
            >
              Review swap
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Side box (one per pay/receive) ─────────────────────────────────────

function SideBox({
  label,
  token,
  counterpart,
  pairs,
  evmAddress,
  prices,
  pickerOpen,
  onPickerOpen,
  onTokenChange,
  value,
  editable,
  onValueChange,
  usdValue,
  footer,
  pickerDefaultFilter,
}: {
  label: string;
  token: TokenPair | null;
  counterpart: TokenPair | null;
  pairs: TokenPair[];
  evmAddress: string;
  prices: PriceRow[] | undefined;
  pickerOpen: boolean;
  onPickerOpen: (open: boolean) => void;
  onTokenChange: (pair: TokenPair | null) => void;
  value: string;
  editable: boolean;
  onValueChange: (next: string) => void;
  usdValue: number | null;
  /** Optional slot rendered below the USD/chip line. Used by the pay
   *  side for quick-pick balance tiles. */
  footer?: ReactNode;
  /** Initial filter pill in the picker dropdown. Pay-side passes
   *  "mine" so the user lands on their balances; receive-side
   *  defaults to "all" since you may want to acquire something you
   *  don't hold yet. */
  pickerDefaultFilter?: "all" | "mine";
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <input
          inputMode="decimal"
          value={value}
          readOnly={!editable}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="0"
          className={cn(
            "min-w-0 flex-1 bg-transparent text-2xl font-semibold outline-none",
            !editable && "text-muted-foreground",
          )}
        />
        <div className="relative">
          <TokenSelectButton
            token={token}
            open={pickerOpen}
            onClick={() => onPickerOpen(!pickerOpen)}
          />
          {pickerOpen && (
            <TokenDropdown
              pairs={pairs}
              selected={token}
              counterpart={counterpart}
              evmAddress={evmAddress}
              prices={prices}
              // When the other side is already set, lock this picker to
              // its chain. Uniswap can't do cross-chain swaps, so the
              // user picking a different chain here would be a dead end.
              lockChainId={counterpart?.chainId}
              defaultFilter={pickerDefaultFilter}
              onSelect={(p) => {
                onTokenChange(p);
                onPickerOpen(false);
              }}
              onClose={() => onPickerOpen(false)}
            />
          )}
        </div>
      </div>
      <div className="mt-1 flex h-[16px] min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate font-mono">
          {usdValue === null ? "" : `≈ ${fmtUsd(usdValue)}`}
        </span>
        {token && <ChainPill chainId={token.chainId} />}
      </div>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}

function ChainPill({ chainId }: { chainId: number }) {
  const slug = networkSlugForChainId(chainId);
  if (!slug) return null;
  return <NetworkChip network={slug} />;
}

// ─── Quote list ─────────────────────────────────────────────────────────

// Uniswap brand pink — used as the badge tint so the venue is
// recognisable at a glance without needing a logo asset.
const UNI_PINK = "#ff007a";

function fmtUsd2(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function feePctLabel(quote: QuoteOption): string {
  // V2 is a fixed 0.30% fee on swapExactTokensForTokens, no `fee`
  // field. V3 stores fee in basis-points * 100 (500 = 0.05%).
  const pct = quote.version === "v2" ? 0.3 : (quote.fee ?? 0) / 10_000;
  return `${pct.toFixed(2)}%`;
}

function QuoteList({
  quotes,
  loading,
  kind,
  tokenIn,
  tokenOut,
  networkFeeUsd,
}: {
  quotes: QuoteOption[] | null;
  loading: boolean;
  kind: Kind;
  tokenIn: TokenPair | null;
  tokenOut: TokenPair | null;
  /** Best-quote-derived gas cost in USD. null while gas / eth-usd are
   *  still loading or when no quote is selected. */
  networkFeeUsd: number | null;
}) {
  const [showFailed, setShowFailed] = useState(false);

  if (!quotes && !loading) return null;

  // Partition into shown-by-default vs collapsed. Failed quotes
  // (no pool, quoter revert, decode error) are noise in the common
  // case — we hide them behind a toggle so the user only sees them
  // when explicitly asking "what else did you try?".
  const available = quotes?.filter((q) => q.available) ?? [];
  const failed = quotes?.filter((q) => !q.available) ?? [];

  return (
    // Provider scoped to the QuoteList so all the per-row tooltips
    // share the same delay / hover semantics without polluting other
    // surfaces with a global TooltipProvider.
    <TooltipProvider delayDuration={200}>
      <div className="rounded-xl border border-border bg-muted/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Available quotes
          </p>
          {loading && (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {quotes && available.length > 0 && (
          <ul className="flex flex-col gap-1">
            {available.map((q, i) => (
              <QuoteRow
                key={`${q.version}:${q.fee ?? ""}`}
                quote={q}
                best={i === 0}
                kind={kind}
                tokenIn={tokenIn}
                tokenOut={tokenOut}
              />
            ))}
          </ul>
        )}

        {failed.length > 0 && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setShowFailed((s) => !s)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={showFailed}
            >
              {showFailed ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              Tried {failed.length} other {failed.length === 1 ? "path" : "paths"}
            </button>
            {showFailed && (
              <ul className="mt-1 flex flex-col gap-1">
                {failed.map((q) => (
                  <QuoteRow
                    key={`${q.version}:${q.fee ?? ""}`}
                    quote={q}
                    best={false}
                    kind={kind}
                    tokenIn={tokenIn}
                    tokenOut={tokenOut}
                  />
                ))}
              </ul>
            )}
          </div>
        )}

        {networkFeeUsd !== null && (
          <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            <span>Network fee</span>
            <span className="font-mono">≈ {fmtUsd2(networkFeeUsd)}</span>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function QuoteRow({
  quote,
  best,
  kind,
  tokenIn,
  tokenOut,
}: {
  quote: QuoteOption;
  best: boolean;
  kind: Kind;
  tokenIn: TokenPair | null;
  tokenOut: TokenPair | null;
}) {
  const display = (() => {
    if (!quote.available || !tokenIn || !tokenOut) return null;
    const wei = kind === "exactIn" ? quote.amountOut : quote.amountIn;
    const decimals =
      kind === "exactIn" ? tokenOut.decimals : tokenIn.decimals;
    const symbol = kind === "exactIn" ? tokenOut.symbol : tokenIn.symbol;
    if (!wei) return null;
    const n = weiToNumber(BigInt(wei), decimals);
    return { value: formatAmount(n, decimals), symbol };
  })();

  const tooltipText = `This is a Uniswap ${quote.version} pool with ${feePctLabel(quote)} fees`;

  return (
    <li
      className={cn(
        "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm",
        best && "bg-primary/10 ring-1 ring-primary/20",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-help items-center gap-1.5">
            {best && (
              <span className="rounded-sm bg-primary/20 px-1 text-[10px] font-bold uppercase tracking-wider text-primary">
                Best
              </span>
            )}
            {/* UNI badge + fee chip. Version is included in the badge
                text (`UNI v2` / `UNI v3`) so v2 and v3 pools that
                share a fee tier (both 0.30%, e.g. AUDD/USDC) are
                still distinguishable at a glance — without it the
                rows are visually identical and only the tooltip
                explains which is which. */}
            <span
              className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background: `${UNI_PINK}1a`, // 10% alpha
                color: UNI_PINK,
              }}
            >
              UNI {quote.version}
            </span>
            <span
              className="rounded-md px-1.5 py-0.5 text-[10px] font-mono font-semibold"
              style={{
                background: `${UNI_PINK}10`, // 6% alpha — softer than the UNI badge
                color: UNI_PINK,
              }}
            >
              {feePctLabel(quote)}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
      <span
        className={cn(
          "font-mono text-xs",
          !quote.available && "text-muted-foreground",
        )}
      >
        {display
          ? `${display.value} ${display.symbol}`
          : friendlyUnavailable(quote.error)}
      </span>
    </li>
  );
}

// Map raw action errors to short user-facing labels. We deliberately
// don't surface "execution reverted" / decode strings — the row is
// already collapsed under "Tried X other paths" so the user only
// sees this if they expanded for a quick "why didn't this work?"
// glance. "No pool" and "No liquidity" cover the two real cases.
function friendlyUnavailable(error: string | undefined): string {
  if (!error) return "Unavailable";
  if (/no pool/i.test(error)) return "No pool";
  return "No liquidity";
}

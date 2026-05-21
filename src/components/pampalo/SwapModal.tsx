import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { ArrowDownUp, Loader2 } from "lucide-react";
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
  TokenDropdown,
  TokenSelectButton,
  type TokenPair,
} from "./AssetSelect";
import { NetworkChip, networkSlugForChainId } from "./NetworkChip";

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

  const inputSideToken = kind === "exactIn" ? tokenIn : tokenOut;

  const getAllQuotes = useAction(api.uniswap.getAllQuotes);
  const [quotes, setQuotes] = useState<QuoteOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the user picks a token on a different chain than the OTHER
  // side already had selected, try to keep the swap same-chain by
  // switching the counterpart to the matching symbol on the new
  // chain. If no match exists, clear it and let the user re-pick.
  function pickIn(next: TokenPair) {
    setTokenIn(next);
    setQuotes(null);
    if (tokenOut && tokenOut.chainId !== next.chainId) {
      const match = pairs?.find(
        (p) => p.symbol === tokenOut.symbol && p.chainId === next.chainId,
      );
      setTokenOut(match ?? null);
    }
  }
  function pickOut(next: TokenPair) {
    setTokenOut(next);
    setQuotes(null);
    if (tokenIn && tokenIn.chainId !== next.chainId) {
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
          <DialogTitle className="text-base font-bold">Swap</DialogTitle>
        </DialogHeader>

        {!pairs ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
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
            />

            <Button
              type="button"
              disabled
              className="mt-1 w-full"
              variant="default"
            >
              Swap (coming soon)
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
}: {
  label: string;
  token: TokenPair | null;
  counterpart: TokenPair | null;
  pairs: TokenPair[];
  evmAddress: string;
  prices: PriceRow[] | undefined;
  pickerOpen: boolean;
  onPickerOpen: (open: boolean) => void;
  onTokenChange: (pair: TokenPair) => void;
  value: string;
  editable: boolean;
  onValueChange: (next: string) => void;
  usdValue: number | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex items-center gap-2">
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
              onSelect={(p) => {
                onTokenChange(p);
                onPickerOpen(false);
              }}
              onClose={() => onPickerOpen(false)}
            />
          )}
        </div>
      </div>
      <div className="mt-1 flex h-[16px] items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {usdValue === null ? "" : `≈ ${fmtUsd(usdValue)}`}
        </span>
        {token && (
          <ChainPill chainId={token.chainId} />
        )}
      </div>
    </div>
  );
}

function ChainPill({ chainId }: { chainId: number }) {
  const slug = networkSlugForChainId(chainId);
  if (!slug) return null;
  return <NetworkChip network={slug} />;
}

// ─── Quote list ─────────────────────────────────────────────────────────

function QuoteList({
  quotes,
  loading,
  kind,
  tokenIn,
  tokenOut,
}: {
  quotes: QuoteOption[] | null;
  loading: boolean;
  kind: Kind;
  tokenIn: TokenPair | null;
  tokenOut: TokenPair | null;
}) {
  if (!quotes && !loading) return null;
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Available quotes
        </p>
        {loading && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </div>
      {quotes && (
        <ul className="flex flex-col gap-1">
          {quotes.map((q, i) => (
            <QuoteRow
              key={`${q.version}:${q.fee ?? ""}`}
              quote={q}
              best={i === 0 && q.available}
              kind={kind}
              tokenIn={tokenIn}
              tokenOut={tokenOut}
            />
          ))}
        </ul>
      )}
    </div>
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
  const label =
    quote.version === "v2"
      ? "V2"
      : `V3 ${(quote.fee! / 10_000).toFixed(2)}%`;

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

  return (
    <li
      className={cn(
        "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm",
        best && "bg-primary/10 ring-1 ring-primary/20",
      )}
    >
      <span className="flex items-center gap-2">
        {best && (
          <span className="rounded-sm bg-primary/20 px-1 text-[10px] font-bold uppercase tracking-wider text-primary">
            Best
          </span>
        )}
        <span className="font-medium">{label}</span>
      </span>
      <span
        className={cn(
          "font-mono text-xs",
          !quote.available && "text-muted-foreground",
        )}
      >
        {display
          ? `${display.value} ${display.symbol}`
          : quote.error ?? "unavailable"}
      </span>
    </li>
  );
}

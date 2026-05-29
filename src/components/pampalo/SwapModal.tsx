import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAction, useQuery } from "convex/react";
import { ArrowDownUp, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { parseUnits } from "ethers";
import { api } from "../../../convex/_generated/api";
import { usePublicBalance, weiToNumber } from "@/lib/balances";
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

// Convert a user-typed amount string in a given unit (token / usd /
// eth) into token-decimal wei. Returns null on parse failure or zero
// — the caller treats null as "no quote, hide the secondary line".
function amountInUnitToTokenWei(
  amountStr: string,
  unit: "token" | "usd" | "eth",
  token: TokenPair,
  tokenPriceUsd: number | null,
  ethUsdPrice: number | null,
): bigint | null {
  try {
    let tokenStr: string;
    if (unit === "token") {
      tokenStr = amountStr;
    } else if (unit === "usd") {
      if (tokenPriceUsd === null || tokenPriceUsd <= 0) return null;
      const usd = Number(amountStr);
      if (!Number.isFinite(usd) || usd <= 0) return null;
      tokenStr = (usd / tokenPriceUsd).toFixed(token.decimals);
    } else {
      // unit === "eth"
      if (!ethUsdPrice || ethUsdPrice <= 0) return null;
      if (tokenPriceUsd === null || tokenPriceUsd <= 0) return null;
      const eth = Number(amountStr);
      if (!Number.isFinite(eth) || eth <= 0) return null;
      const usd = eth * ethUsdPrice;
      tokenStr = (usd / tokenPriceUsd).toFixed(token.decimals);
    }
    const parsed = parseUnits(tokenStr, token.decimals);
    return parsed <= 0n ? null : parsed;
  } catch {
    return null;
  }
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
  const tokensRaw = useQuery(api.catalog.tokens.list, {});
  const prices = useQuery(api.prices.feeds.listLatest, {});

  // ETH/USD spot — referenced by the input-mode toggle (USD ↔ ETH
  // conversion on the pay side) and by the network-fee USD line under
  // the quote list. Declared early so both sites share a single
  // memoised reference.
  const ethUsdPrice = useMemo<number | null>(() => {
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  }, [prices]);

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
    api.prices.gas.latestForChain,
    activeChainId !== null ? { chainId: activeChainId } : "skip",
  );

  const getAllQuotes = useAction(api.swap.actions.getAllQuotes);
  const [quotes, setQuotes] = useState<QuoteOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pay-side input unit. Same pattern as SendModal — the user can
  // type in token-native units, USD, or ETH; we convert to token-wei
  // for the quote engine + over-balance check on every keystroke. The
  // toggle cycles token → usd → eth → token, skipping ETH when the
  // pay token IS ETH (avoids a degenerate ETH-in-ETH toggle).
  type InputUnit = "token" | "usd" | "eth";
  const [payInputUnit, setPayInputUnit] = useState<InputUnit>("token");
  // Reset to token whenever the user picks a new pay token so the
  // unit label and input never get out of sync.
  useEffect(() => {
    setPayInputUnit("token");
  }, [tokenIn?.symbol, tokenIn?.chainId]);

  const tokenInPriceUsd = useMemo(
    () => usdPriceFor(tokenIn, prices ?? undefined),
    [tokenIn, prices],
  );

  // rawAmount → token-wei, honouring the current input unit. Returns
  // null when the input doesn't parse or evaluates to zero; the quote
  // effect treats that as "no quote".
  const payAmountWei = useMemo<bigint | null>(() => {
    if (kind !== "exactIn" || !tokenIn) return null;
    if (!rawAmount) return null;
    return amountInUnitToTokenWei(
      rawAmount,
      payInputUnit,
      tokenIn,
      tokenInPriceUsd,
      ethUsdPrice,
    );
  }, [kind, rawAmount, payInputUnit, tokenIn, tokenInPriceUsd, ethUsdPrice]);

  const cyclePayInputUnit = () => {
    if (!tokenIn || tokenInPriceUsd === null || tokenInPriceUsd <= 0) return;
    const isEth = tokenIn.symbol === "ETH";
    const ethAllowed = !isEth && ethUsdPrice !== null && ethUsdPrice > 0;
    const order: InputUnit[] = ethAllowed
      ? ["token", "usd", "eth"]
      : ["token", "usd"];
    const idx = order.indexOf(payInputUnit);
    const next = order[(idx + 1) % order.length];
    // Re-express the current amount in the new unit so the user's
    // typing isn't silently nuked by the toggle.
    if (payAmountWei !== null) {
      const tokenAmt = weiToNumber(payAmountWei, tokenIn.decimals);
      if (next === "token") {
        setRawAmount(formatAmount(tokenAmt, tokenIn.decimals));
      } else if (next === "usd") {
        setRawAmount((tokenAmt * tokenInPriceUsd).toFixed(2));
      } else if (ethUsdPrice && ethUsdPrice > 0) {
        setRawAmount(((tokenAmt * tokenInPriceUsd) / ethUsdPrice).toFixed(6));
      }
    }
    setPayInputUnit(next);
  };

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
  // before touching React state. For exactIn we use `payAmountWei`,
  // which is rawAmount converted from the active input unit
  // (token/usd/eth) into token-wei. For exactOut we still parse
  // rawAmount as receive-side token-units.
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
    if (kind === "exactIn") {
      if (payAmountWei === null) {
        setQuotes(null);
        setError(null);
        return;
      }
      parsed = payAmountWei;
    } else {
      try {
        parsed = parseUnits(rawAmount || "0", inputSideToken.decimals);
      } catch {
        setError("Invalid amount");
        setQuotes(null);
        return;
      }
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
    payAmountWei,
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
  //     prices cron — see convex/prices.ts; declared above so the
  //     input-unit toggle can share it).
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
      <DialogContent
        // Cap the dialog at the viewport and scroll when content
        // (Review pane with all the breakdown rows) gets tall on
        // mobile. The close button stays pinned to the top-right via
        // its `absolute` positioning inside DialogContent — it
        // doesn't scroll with the body. `overscroll-contain` keeps
        // page scroll from leaking past the modal's bounds on iOS.
        className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain"
      >
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
              ethUsdPrice={ethUsdPrice}
              inputUnit={payInputUnit}
              onCycleInputUnit={cyclePayInputUnit}
              tokenAmountWei={
                kind === "exactIn"
                  ? payAmountWei
                  : best?.amountIn
                    ? BigInt(best.amountIn)
                    : null
              }
              showBalance
              onFillBalance={(amt) => {
                setKind("exactIn");
                setRawAmount(amt);
              }}
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
  ethUsdPrice,
  inputUnit,
  onCycleInputUnit,
  tokenAmountWei,
  showBalance,
  onFillBalance,
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
  /** ETH/USD spot. null hides the ETH leg of the toggle. */
  ethUsdPrice?: number | null;
  /** Active input unit on the pay side. Drives the trailing unit
   *  label and the secondary equivalent line. */
  inputUnit?: "token" | "usd" | "eth";
  /** Cycle handler — undefined hides the toggle button. */
  onCycleInputUnit?: () => void;
  /** Effective token-wei amount the side represents. Used for the
   *  over-balance guard on the pay side. */
  tokenAmountWei?: bigint | null;
  /** Pay-side only — render the Balance row with the Max button. */
  showBalance?: boolean;
  /** Called with the decimal amount string when the user taps Max.
   *  Caller is responsible for honouring `inputUnit`. */
  onFillBalance?: (amount: string) => void;
  /** Optional slot rendered below the USD/chip line. Used by the pay
   *  side for quick-pick balance tiles. */
  footer?: ReactNode;
  /** Initial filter pill in the picker dropdown. Pay-side passes
   *  "mine" so the user lands on their balances; receive-side
   *  defaults to "all" since you may want to acquire something you
   *  don't hold yet. */
  pickerDefaultFilter?: "all" | "mine";
}) {
  // Live balance for the pay side. The hook always fires so the hook
  // count is stable across renders; we pass a sentinel AssetRef + null
  // userAddress when no token is selected so it short-circuits without
  // hitting the RPC. Same shape as SendModal.
  const balanceHook = usePublicBalance(
    token
      ? {
          chainId: token.chainId,
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
        }
      : {
          chainId: 1,
          address: "0x0000000000000000000000000000000000000000",
          symbol: "",
          decimals: 18,
        },
    token && showBalance ? evmAddress : null,
  );
  const balanceWei = balanceHook.data?.balanceWei ?? null;
  const balanceNumber =
    balanceWei !== null && token
      ? weiToNumber(balanceWei, token.decimals)
      : null;

  const isEthAsset = token?.symbol === "ETH";
  const tokenPriceUsd = token ? usdPriceFor(token, prices) : null;
  const showInputToggle =
    !!onCycleInputUnit &&
    !!token &&
    tokenPriceUsd !== null &&
    tokenPriceUsd > 0;
  const isOverBalance =
    showBalance &&
    tokenAmountWei !== null &&
    tokenAmountWei !== undefined &&
    balanceWei !== null &&
    tokenAmountWei > balanceWei;

  // Trailing unit label after the input (ETH/USD/symbol).
  const unitLabel = (() => {
    if (!token) return "";
    if (inputUnit === "usd") return "USD";
    if (inputUnit === "eth") return "ETH";
    return token.symbol;
  })();

  // Next-unit hint for the toggle button (matches SendModal copy:
  // "View in USD" / "View in ETH" / "View in {symbol}").
  const nextUnitLabel = (() => {
    if (!token) return "";
    const order: Array<"token" | "usd" | "eth"> = isEthAsset
      ? ["token", "usd"]
      : ethUsdPrice
        ? ["token", "usd", "eth"]
        : ["token", "usd"];
    const idx = order.indexOf(inputUnit ?? "token");
    const next = order[(idx + 1) % order.length];
    if (next === "usd") return "USD";
    if (next === "eth") return "ETH";
    return token.symbol;
  })();

  // Secondary line under the input. Shows the OTHER equivalents so
  // the user always sees the same amount in another denomination.
  const secondaryLine = (() => {
    if (!token || tokenAmountWei === null || tokenAmountWei === undefined) {
      return "";
    }
    const tokenAmt = weiToNumber(tokenAmountWei, token.decimals);
    if (inputUnit === "token" || inputUnit === undefined) {
      return usdValue === null ? "" : `≈ ${fmtUsd(usdValue)}`;
    }
    if (inputUnit === "usd") {
      return `≈ ${formatAmount(tokenAmt, token.decimals)} ${token.symbol}`;
    }
    // inputUnit === "eth" — show the receive-side asset amount.
    return `≈ ${formatAmount(tokenAmt, token.decimals)} ${token.symbol}`;
  })();

  // Max button respects the current input unit so the user sees a
  // sensible number land in the field instead of mode-mismatched
  // digits.
  const onMax = () => {
    if (!token || !onFillBalance || balanceWei === null) return;
    const reserveWei = isEthAsset ? 5_000_000_000_000_000n : 0n; // 0.005 ETH
    const maxWei =
      balanceWei > reserveWei ? balanceWei - reserveWei : balanceWei;
    if (maxWei <= 0n) {
      onFillBalance("");
      return;
    }
    const maxNumber = weiToNumber(maxWei, token.decimals);
    if (inputUnit === "usd" && tokenPriceUsd !== null && tokenPriceUsd > 0) {
      onFillBalance((maxNumber * tokenPriceUsd).toFixed(2));
      return;
    }
    if (
      inputUnit === "eth" &&
      tokenPriceUsd !== null &&
      tokenPriceUsd > 0 &&
      ethUsdPrice &&
      ethUsdPrice > 0
    ) {
      onFillBalance(((maxNumber * tokenPriceUsd) / ethUsdPrice).toFixed(6));
      return;
    }
    const maxDp = token.decimals === 18 ? 6 : 4;
    onFillBalance(
      maxNumber.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDp,
        useGrouping: false,
      }),
    );
  };

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
            "input-fit-content min-w-[1.5ch] max-w-full bg-transparent text-2xl font-semibold outline-none",
            !editable && "text-muted-foreground",
          )}
        />
        {token && unitLabel && (
          <span className="shrink-0 text-base font-medium text-ink-mute/70">
            {unitLabel}
          </span>
        )}
        <div className="relative ml-auto">
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
        <div className="flex min-w-0 items-center gap-2">
          {isOverBalance ? (
            <span className="min-w-0 truncate text-destructive">
              Insufficient balance
            </span>
          ) : (
            <span className="min-w-0 truncate font-mono">{secondaryLine}</span>
          )}
          {showInputToggle && (
            <button
              type="button"
              onClick={onCycleInputUnit}
              className="shrink-0 text-[10.5px] font-medium text-ink-mute underline-offset-2 hover:text-ink hover:underline"
            >
              View in {nextUnitLabel}
            </button>
          )}
        </div>
        {token && <ChainPill chainId={token.chainId} />}
      </div>
      {showBalance && token && balanceNumber !== null && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">
            Balance:{" "}
            {balanceNumber.toLocaleString("en-US", {
              minimumFractionDigits: 0,
              maximumFractionDigits: token.decimals === 18 ? 6 : 4,
              useGrouping: false,
            })}{" "}
            {token.symbol}
          </span>
          {onFillBalance && balanceWei !== null && balanceWei > 0n && (
            <button
              type="button"
              onClick={onMax}
              className="rounded-md border border-line bg-paper-lo px-2 py-0.5 text-[10.5px] font-semibold text-ink hover:bg-paper"
            >
              Max
            </button>
          )}
        </div>
      )}
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

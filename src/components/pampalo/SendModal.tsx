import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import {
  ArrowDown,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react";
import { parseUnits } from "ethers";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import {
  signTransactionWithPasskey,
  PrfNotSupportedError,
} from "@/lib/auth-flow";
import {
  usePublicBalance,
  weiToNumber,
} from "@/lib/balances";
import { appendTransaction } from "@/lib/idb-transactions";
import { useRpcClient } from "@/lib/rpc";
import { buildSendTx, isNativeToken, normalizeRecipient } from "@/lib/send-tx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AssetMark } from "./AssetMark";
import {
  BalanceTiles,
  TokenDropdown,
  TokenSelectButton,
  type TokenPair,
} from "./AssetSelect";
import {
  GasTierPicker,
  GAS_TIER_MULTIPLIER,
  scaleByTier,
  type GasTier,
} from "./GasTierPicker";
import {
  NetworkChip,
  networkSlugForChainId,
  type NetworkSlug,
} from "./NetworkChip";

// Confirmations required before we flip the tracking UI from "pending"
// to "confirmed". One block is enough on the L2s we target (Base) and
// on testnets; mainnet finality is genuinely probabilistic but this is
// a wallet, not a CEX — one block matches what Metamask shows by
// default. Anything higher and we'd be lying about the chain state.
const CONFIRMATIONS_THRESHOLD = 1;

// How often the post-send UI polls the RPC for receipt status. 4 s
// strikes the balance between "feels live" (blocks land every 2-12 s
// across the chains we touch) and "doesn't hammer the proxy".
const TRACKING_POLL_MS = 4_000;

// Fallback gas-limit estimate when eth_estimateGas reverts. 21k for a
// bare ETH transfer, 65k for an ERC20 transfer covers every storage
// path the standard `transfer` function takes.
const FALLBACK_GAS_NATIVE = 21_000n;
const FALLBACK_GAS_ERC20 = 65_000n;

type PriceRow = {
  shortId: string;
  answer: string;
  feedDecimals: number;
};

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
    minimumFractionDigits: n < 0.01 && n > 0 ? 4 : 2,
    maximumFractionDigits: n < 0.01 && n > 0 ? 4 : 2,
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

type Phase = "compose" | "review" | "submitting" | "tracking";

type SubmittedTx = {
  chainId: number;
  txHash: string;
  /** Snapshot of the compose-screen state so the tracking UI can
   *  render the same token/amount/recipient row without re-deriving
   *  from the IDB record. */
  token: TokenPair;
  recipient: string;
  amountWei: string;
  amountDecimal: string;
  submittedAt: number;
};

export function SendModal({
  open,
  onOpenChange,
  evmAddress,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** User's EVM address — needed for picker balances + nonce lookup. */
  evmAddress: string;
}) {
  const tokensRaw = useQuery(api.tokens.list, {});
  const prices = useQuery(api.prices.listLatest, {});

  const pairs = useMemo<TokenPair[] | null>(() => {
    if (!tokensRaw) return null;
    return tokensRaw.map(
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

  const [token, setToken] = useState<TokenPair | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("compose");
  const [submitted, setSubmitted] = useState<SubmittedTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Gas tier — same picker the swap-review uses. "standard" matches
  // the cron's last-observed price exactly; the other tiers scale it.
  // See ADR 0004 for why we use the cached cron data rather than a
  // fresh per-send fetch.
  const [tier, setTier] = useState<GasTier>("standard");
  const [feeOpen, setFeeOpen] = useState(false);

  // Reset everything when the modal closes. Without this a user who
  // sends → closes → reopens lands on the tracking screen for a tx
  // that's no longer top-of-mind. The IDB record persists either way.
  useEffect(() => {
    if (!open) {
      setPhase("compose");
      setSubmitted(null);
      setError(null);
      setAmount("");
      setRecipient("");
      setTier("standard");
      setFeeOpen(false);
    }
  }, [open]);

  const activeChainId = token?.chainId ?? null;
  const gas = useQuery(
    api.gas.latestForChain,
    activeChainId !== null ? { chainId: activeChainId } : "skip",
  );

  const recipientLc = normalizeRecipient(recipient);

  // Parse the typed amount in token-native units. Errors are surfaced
  // in the inline message — the review button stays disabled until
  // this resolves to a positive bigint.
  const amountWei: bigint | null = (() => {
    if (!token) return null;
    if (!amount) return null;
    try {
      const parsed = parseUnits(amount, token.decimals);
      if (parsed <= 0n) return null;
      return parsed;
    } catch {
      return null;
    }
  })();

  const amountUsd = (() => {
    if (!token || amountWei === null) return null;
    const price = usdPriceFor(token, prices ?? undefined);
    if (price === null) return null;
    return weiToNumber(amountWei, token.decimals) * price;
  })();

  // Self-send guard — pasting your own address is almost always a
  // mistake, and the gas+revert combination wastes real money. We
  // block at the review stage rather than the field so the user can
  // still paste and check.
  const isSelfSend =
    recipientLc !== null && recipientLc === evmAddress.toLowerCase();

  // ETH gas estimate using cached cron data. Same maths as ReviewSwap:
  // gasUnits × gasPriceWei × eth/usd, with bigint→Number conversion
  // staged through gwei to stay below 2^53. Per ADR 0004 we skip
  // eth_estimateGas entirely and use the fallback constant for the
  // user's token kind — accurate enough for ETH and standard ERC20s.
  const ethUsdPrice = (() => {
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  })();
  const baseGasUnits = token
    ? isNativeToken(token.address)
      ? FALLBACK_GAS_NATIVE
      : FALLBACK_GAS_ERC20
    : null;
  // Same 1.2× pad we apply at sign time; surface the padded number in
  // the picker so the displayed USD matches what the user will actually
  // be billed for.
  const paddedGasUnits =
    baseGasUnits !== null ? (baseGasUnits * 120n) / 100n : null;
  // Compose-screen network-fee preview at the currently-selected tier
  // (picked again on the review pane). Lets the user see roughly what
  // they'll spend on gas before drilling in.
  const composeGasUsd = (() => {
    if (!gas?.gasPriceWei || paddedGasUnits === null || ethUsdPrice === null) {
      return null;
    }
    const scaled = scaleByTier(BigInt(gas.gasPriceWei), tier);
    const totalGwei = (paddedGasUnits * scaled) / 1_000_000_000n;
    return (Number(totalGwei) / 1e9) * ethUsdPrice;
  })();

  // ── Submit handler ──────────────────────────────────────────────────
  const rpc = useRpcClient();

  async function onConfirm() {
    if (!token || amountWei === null || !recipientLc) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    setError(null);
    setPhase("submitting");
    try {
      // Build the unsigned tx skeleton, then assemble fee fields
      // client-side from the latestGas cron snapshot + the user's tier
      // choice. The server never sees the unsigned (from, to, value,
      // data) tuple in transit — only the signed rawTx at broadcast.
      const skeleton = buildSendTx({
        tokenAddress: token.address,
        recipient: recipientLc,
        amountWei,
      });
      // Nonce is a thin atomic proxy call — same leak profile as the
      // existing balance proxies (chainId + address only). See ADR 0004.
      const nonceRes = await rpc.getNonce(token.chainId, evmAddress);

      const fallback = isNativeToken(token.address)
        ? FALLBACK_GAS_NATIVE
        : FALLBACK_GAS_ERC20;
      const gasLimit = (fallback * 120n) / 100n;

      // Scale the cron-observed gasPriceWei by the picked tier. If the
      // cron also captured 1559 fields, scale the priority fee by the
      // same multiplier and set maxFeePerGas = scaled-gas-price (which
      // already covers base * 2 + tip headroom because the cron's
      // gasPriceWei is the network's quoted price at fetch time).
      const baseGasPriceWei = BigInt(gas.gasPriceWei);
      const scaledGasPriceWei = scaleByTier(baseGasPriceWei, tier);
      const usePriority = gas.priorityFeeWei !== undefined;
      const maxPriorityFeePerGas = usePriority
        ? scaleByTier(BigInt(gas.priorityFeeWei!), tier)
        : undefined;
      const maxFeePerGas = usePriority ? scaledGasPriceWei : undefined;
      const legacyGasPrice = usePriority ? undefined : scaledGasPriceWei;

      const signed = await signTransactionWithPasskey({
        chainId: token.chainId,
        to: skeleton.to,
        value: BigInt(skeleton.value),
        data: skeleton.data,
        nonce: Number(nonceRes.nonce),
        gasLimit,
        gasPrice: legacyGasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const { txHash } = await rpc.sendRawTransaction(token.chainId, signed);

      // Persist the bare-minimum record to IDB so we can reconstruct
      // it later in a transaction-history view (TRANSACTION_STORAGE.md).
      const submittedAt = Date.now();
      const submitRecord: SubmittedTx = {
        chainId: token.chainId,
        txHash,
        token,
        recipient: recipientLc,
        amountWei: amountWei.toString(),
        amountDecimal: amount,
        submittedAt,
      };
      await appendTransaction({
        chainId: token.chainId,
        txHash,
        submittedAt,
        raw: JSON.stringify({
          kind: isNativeToken(token.address) ? "native" : "erc20",
          tokenAddress: token.address,
          tokenSymbol: token.symbol,
          tokenDecimals: token.decimals,
          from: evmAddress.toLowerCase(),
          to: recipientLc,
          amountWei: amountWei.toString(),
        }),
      });
      setSubmitted(submitRecord);
      setPhase("tracking");
      toast("Transaction submitted");
    } catch (e) {
      const msg =
        e instanceof PrfNotSupportedError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Couldn’t send transaction.";
      setError(msg);
      // Land back on review so the user can tweak rather than re-typing
      // recipient + amount from scratch.
      setPhase("review");
    }
  }

  // Convenience: prefill the amount with the user's whole balance.
  // Only meaningful when a token is picked and the balance hook has
  // resolved; otherwise no-op.
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
    token ? evmAddress : null,
  );
  const balanceWei = balanceHook.data?.balanceWei ?? null;
  const balanceNumber =
    balanceWei !== null && token
      ? weiToNumber(balanceWei, token.decimals)
      : null;

  function fillMax() {
    if (!token || balanceWei === null) return;
    // Reserve a gas margin only for native sends — token transfers cost
    // gas in ETH, not the token, so the full balance is legitimately
    // sendable.
    if (isNativeToken(token.address)) {
      // Leave 0.0005 ETH for gas headroom (rough, conservative — works
      // on mainnet at 50 gwei and on cheap L2s). User can still type
      // a higher number manually if they really want.
      const gasReserveWei = parseUnits("0.0005", 18);
      const max = balanceWei > gasReserveWei ? balanceWei - gasReserveWei : 0n;
      if (max <= 0n) {
        toast("Not enough ETH for gas");
        return;
      }
      setAmount(weiToNumber(max, token.decimals).toString());
    } else {
      setAmount(weiToNumber(balanceWei, token.decimals).toString());
    }
  }

  const composeReady =
    token !== null &&
    amountWei !== null &&
    recipientLc !== null &&
    !isSelfSend;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">
            {phase === "tracking"
              ? "Transaction sent"
              : phase === "review" || phase === "submitting"
                ? "Review transaction"
                : "Send"}
          </DialogTitle>
        </DialogHeader>

        {!pairs ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : phase === "tracking" && submitted ? (
          <TrackingPane
            tx={submitted}
            onDone={() => onOpenChange(false)}
            prices={prices ?? undefined}
          />
        ) : phase === "review" || phase === "submitting" ? (
          token && amountWei !== null && recipientLc ? (
            <ReviewPane
              token={token}
              recipient={recipientLc}
              amountWei={amountWei}
              amountUsd={amountUsd}
              gasPriceWei={gas?.gasPriceWei ?? null}
              gasUnits={paddedGasUnits}
              ethUsdPrice={ethUsdPrice}
              tier={tier}
              onTierChange={setTier}
              feeOpen={feeOpen}
              onFeeToggle={() => setFeeOpen((o) => !o)}
              submitting={phase === "submitting"}
              error={error}
              onBack={() => {
                setError(null);
                setPhase("compose");
              }}
              onConfirm={onConfirm}
            />
          ) : null
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                You send
              </p>
              <div className="flex min-w-0 items-center gap-2">
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                  className="min-w-0 flex-1 bg-transparent text-2xl font-semibold outline-none"
                />
                <div className="relative">
                  <TokenSelectButton
                    token={token}
                    open={pickerOpen}
                    onClick={() => setPickerOpen((o) => !o)}
                  />
                  {pickerOpen && (
                    <TokenDropdown
                      pairs={pairs}
                      selected={token}
                      counterpart={null}
                      evmAddress={evmAddress}
                      prices={prices ?? undefined}
                      defaultFilter="mine"
                      onSelect={(p) => {
                        setToken(p);
                        setAmount("");
                        setPickerOpen(false);
                      }}
                      onClose={() => setPickerOpen(false)}
                    />
                  )}
                </div>
              </div>
              <div className="mt-1 flex h-[16px] min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate font-mono">
                  {amountUsd === null ? "" : `≈ ${fmtUsd(amountUsd)}`}
                </span>
                {token && <ChainPill chainId={token.chainId} />}
              </div>
              {/* Balance + Max button on its own row. Hidden until a
                  token is picked. */}
              {token && balanceNumber !== null && (
                <div className="mt-2 flex items-center justify-end gap-2">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    Balance: {formatAmount(balanceNumber, token.decimals)}{" "}
                    {token.symbol}
                  </span>
                  <button
                    type="button"
                    onClick={fillMax}
                    className="rounded-md border border-line bg-paper-lo px-2 py-0.5 text-[10.5px] font-semibold text-ink hover:bg-paper"
                  >
                    Max
                  </button>
                </div>
              )}
              <div className="mt-2">
                <BalanceTiles
                  pairs={pairs}
                  evmAddress={evmAddress}
                  selected={token}
                  counterpart={null}
                  onSelect={(p) => {
                    setToken(p);
                    setAmount("");
                  }}
                />
              </div>
            </div>

            <div className="flex justify-center">
              <span className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
                <ArrowDown className="size-3.5" />
              </span>
            </div>

            <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Recipient
              </p>
              <input
                inputMode="text"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x…"
                className="w-full bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
              />
              <div className="mt-1 flex h-[16px] items-center justify-between text-[11px]">
                {recipient && recipientLc === null ? (
                  <span className="text-destructive">Invalid address</span>
                ) : isSelfSend ? (
                  <span className="text-destructive">
                    That’s your own address.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Double-check the address — sends can’t be reversed.
                  </span>
                )}
              </div>
            </div>

            {composeGasUsd !== null && composeReady && (
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                <span>Estimated network fee</span>
                <span className="font-mono">≈ {fmtUsd(composeGasUsd)}</span>
              </div>
            )}

            <Button
              type="button"
              disabled={!composeReady}
              className="mt-1 w-full"
              variant="default"
              onClick={() => setPhase("review")}
            >
              Review transaction
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Review pane ────────────────────────────────────────────────────────

function ReviewPane({
  token,
  recipient,
  amountWei,
  amountUsd,
  gasPriceWei,
  gasUnits,
  ethUsdPrice,
  tier,
  onTierChange,
  feeOpen,
  onFeeToggle,
  submitting,
  error,
  onBack,
  onConfirm,
}: {
  token: TokenPair;
  recipient: string;
  amountWei: bigint;
  amountUsd: number | null;
  gasPriceWei: string | null;
  gasUnits: bigint | null;
  ethUsdPrice: number | null;
  tier: GasTier;
  onTierChange: (next: GasTier) => void;
  feeOpen: boolean;
  onFeeToggle: () => void;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const amountNumber = weiToNumber(amountWei, token.decimals);
  // Compute the selected-tier USD locally (same formula as
  // GasTierPicker uses internally) so the cost-breakdown rows agree
  // with the picker.
  const selectedGasUsd = (() => {
    if (!gasPriceWei || gasUnits === null || ethUsdPrice === null) return null;
    const scaled =
      (BigInt(gasPriceWei) * BigInt(Math.round(GAS_TIER_MULTIPLIER[tier] * 100))) /
      100n;
    const totalGwei = (gasUnits * scaled) / 1_000_000_000n;
    return (Number(totalGwei) / 1e9) * ethUsdPrice;
  })();
  const totalUsd = amountUsd !== null ? amountUsd + (selectedGasUsd ?? 0) : null;
  const slug = networkSlugForChainId(token.chainId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-mute hover:text-ink-soft disabled:opacity-50"
        >
          <ArrowLeft className="size-4" />
          Edit
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            You send
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
                {formatAmount(amountNumber, token.decimals)} {token.symbol}
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
                {slug && <NetworkChip network={slug} />}
                {amountUsd !== null && (
                  <span className="font-mono">≈ {fmtUsd(amountUsd)}</span>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-center">
          <span className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
            <ArrowDown className="size-3.5" />
          </span>
        </div>

        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Recipient
          </p>
          <code className="block break-all font-mono text-[13px] text-ink">
            {recipient}
          </code>
        </div>
      </div>

      {/* Gas tier picker — same control surface as the swap-review
          pane. Collapsed by default; user expands to compare tiers. */}
      <GasTierPicker
        tier={tier}
        onTierChange={onTierChange}
        open={feeOpen}
        onToggle={onFeeToggle}
        gasPriceWei={gasPriceWei}
        gasUnits={gasUnits}
        ethUsdPrice={ethUsdPrice}
      />

      <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-[13px]">
        <div className="flex items-center justify-between text-ink-soft">
          <span>Asset sent value</span>
          <span className="font-mono">
            {amountUsd !== null ? fmtUsd(amountUsd) : "—"}
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
            {totalUsd !== null ? fmtUsd(totalUsd) : "—"}
          </span>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <Button
        type="button"
        disabled={submitting}
        className="w-full"
        onClick={onConfirm}
      >
        {submitting ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            Confirm with passkey…
          </>
        ) : (
          "Confirm and sign"
        )}
      </Button>
    </div>
  );
}

// ─── Tracking pane ──────────────────────────────────────────────────────
// Polls `eth_getTransactionReceipt` + `eth_blockNumber` via the rpcProxy
// every TRACKING_POLL_MS until the receipt comes back, then keeps polling
// until we hit CONFIRMATIONS_THRESHOLD or the tx reverts.

type TrackingStatus =
  | { kind: "pending"; confirmations: 0 }
  | { kind: "confirming"; confirmations: number }
  | { kind: "confirmed"; confirmations: number; blockNumber: number }
  | { kind: "reverted"; blockNumber: number }
  | { kind: "error"; message: string };

function TrackingPane({
  tx,
  onDone,
  prices,
}: {
  tx: SubmittedTx;
  onDone: () => void;
  prices: PriceRow[] | undefined;
}) {
  const rpc = useRpcClient();
  const [status, setStatus] = useState<TrackingStatus>({
    kind: "pending",
    confirmations: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await rpc.getTransactionStatus(tx.chainId, tx.txHash);
        if (cancelled) return;
        if (res.status === null) {
          setStatus({ kind: "pending", confirmations: 0 });
        } else if (res.status === false) {
          setStatus({
            kind: "reverted",
            blockNumber: res.blockNumber ?? 0,
          });
          return; // stop polling on terminal state
        } else if (res.confirmations >= CONFIRMATIONS_THRESHOLD) {
          setStatus({
            kind: "confirmed",
            confirmations: res.confirmations,
            blockNumber: res.blockNumber ?? 0,
          });
          return;
        } else {
          setStatus({
            kind: "confirming",
            confirmations: res.confirmations,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: e instanceof Error ? e.message : "Receipt lookup failed",
        });
      }
      // Reschedule. Use setTimeout instead of setInterval so a slow
      // proxy round-trip doesn't pile up overlapping requests. The
      // early-returns above already handle the cancelled path.
      timer = setTimeout(tick, TRACKING_POLL_MS);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, tx.chainId, tx.txHash]);

  const slug = networkSlugForChainId(tx.chainId);
  const amountNumber = weiToNumber(BigInt(tx.amountWei), tx.token.decimals);
  const usd = (() => {
    const price = usdPriceFor(tx.token, prices);
    if (price === null) return null;
    return amountNumber * price;
  })();

  const explorerUrl = explorerLink(tx.chainId, tx.txHash);

  return (
    <div className="flex flex-col gap-4">
      <StatusBanner status={status} />

      <div className="rounded-xl border border-border bg-muted/30 p-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Sent
        </p>
        <div className="flex items-center gap-3">
          <span className="relative">
            <AssetMark symbol={tx.token.symbol} size={32} />
            {slug && (
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-popover"
                style={{ background: chainDot(slug) }}
              />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[16px] font-semibold text-ink">
              {formatAmount(amountNumber, tx.token.decimals)} {tx.token.symbol}
            </span>
            <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
              {slug && <NetworkChip network={slug} />}
              {usd !== null && <span className="font-mono">≈ {fmtUsd(usd)}</span>}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-3 text-[12px] text-ink-soft">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            To
          </span>
          <code className="truncate font-mono text-[11.5px]">
            {tx.recipient}
          </code>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Transaction
          </span>
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-[11.5px] text-[var(--pub)] hover:underline"
            >
              {tx.txHash.slice(0, 10)}…{tx.txHash.slice(-6)}
            </a>
          ) : (
            <code className="truncate font-mono text-[11.5px]">
              {tx.txHash.slice(0, 10)}…{tx.txHash.slice(-6)}
            </code>
          )}
        </div>
      </div>

      <Button type="button" className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function StatusBanner({ status }: { status: TrackingStatus }) {
  if (status.kind === "confirmed") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--pub)]/30 bg-[var(--pub-soft)] px-3 py-2.5 text-[13px] text-ink">
        <CheckCircle2 className="size-4 text-[var(--pub)]" />
        <span className="flex-1">
          Confirmed in block #{status.blockNumber.toLocaleString()}.
        </span>
        <span className="font-mono text-[11px] text-ink-mute">
          {status.confirmations} conf
        </span>
      </div>
    );
  }
  if (status.kind === "reverted") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-ink">
        <XCircle className="size-4 text-destructive" />
        <span className="flex-1">
          The transaction reverted on-chain. No funds moved.
        </span>
      </div>
    );
  }
  if (status.kind === "confirming") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-[13px] text-ink">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="flex-1">Mined — waiting for confirmations.</span>
        <span className="font-mono text-[11px] text-ink-mute">
          {status.confirmations}/{CONFIRMATIONS_THRESHOLD}
        </span>
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-ink">
        <XCircle className="size-4 text-destructive" />
        <span className="flex-1">{status.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-[13px] text-ink">
      <Clock className="size-4 animate-pulse text-muted-foreground" />
      <span className="flex-1">Submitted — waiting for a block.</span>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function ChainPill({ chainId }: { chainId: number }) {
  const slug = networkSlugForChainId(chainId);
  if (!slug) return null;
  return <NetworkChip network={slug} />;
}

function chainDot(slug: NetworkSlug): string {
  if (slug === "base") return "#0052FF";
  if (slug === "eth") return "#627EEA";
  return "currentColor";
}

// Block-explorer URL builder. Null when we don't have one for the chain;
// the tracking pane gracefully renders a plain mono hash in that case.
function explorerLink(chainId: number, txHash: string): string | null {
  switch (chainId) {
    case 1:
      return `https://etherscan.io/tx/${txHash}`;
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    case 421614:
      return `https://sepolia.arbiscan.io/tx/${txHash}`;
    case 42161:
      return `https://arbiscan.io/tx/${txHash}`;
    default:
      return null;
  }
}

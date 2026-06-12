import { useEffect, useMemo, useRef, useState } from "react";
import { Interface } from "ethers";
import { useQuery } from "convex/react";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { signTransactionWithPasskey } from "@/lib/auth-flow";
import { weiToNumber } from "@/lib/balances";
import { txUrl } from "@/lib/explorer";
import { patchNoteByLeaf } from "@/lib/idb-notes";
import { useRpcClient } from "@/lib/rpc";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AssetMark } from "../AssetMark";

// Shielder-side "cancel my pending shield" flow. Unlike Contest (a
// VIGILANT_CITIZEN action on someone else's shield), this is the shielder
// cancelling their own queued shield before it unlocks — `cancelShield(id)`
// refunds the escrow to their public wallet. The passkey ceremony is the
// confirmation step. Optimistically marks the IDB note cancelled so it
// drops out of the pending list immediately.

const CANCEL_GAS_LIMIT = 300_000n;
const PAMPALO_IFACE = new Interface([
  "function cancelShield(uint256 id) external",
]);

const RECEIPT_POLL_MS = 2_500;
const RECEIPT_TIMEOUT_MS = 60_000;

export type CancelShieldPayload = {
  pendingId: string;
  chainId: number;
  pampaloAddress: string;
  amount: bigint;
  symbol: string;
  decimals: number;
  leafCommitment: string;
  priceUsd?: number | null;
};

type Phase = "idle" | "signing" | "submitting" | "awaiting" | "confirmed" | "error";

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: CancelShieldPayload | null;
  evmAddress: string | null;
};

export function CancelShieldSheet({
  open,
  onOpenChange,
  payload,
  evmAddress,
}: Props) {
  const isDesktop = useIsDesktop();
  const rpc = useRpcClient();
  const gas = useQuery(
    api.prices.gas.latestForChain,
    payload ? { chainId: payload.chainId } : "skip",
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const cancelRef = useRef(false);
  // Read through a function so TS doesn't narrow the mutable ref to a
  // constant across awaits (it can flip true when the sheet closes mid-poll).
  const isAborted = () => cancelRef.current;

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setError(null);
      setTxHash(null);
      cancelRef.current = true;
    } else {
      cancelRef.current = false;
    }
  }, [open]);

  const amountFmt = useMemo(() => {
    if (!payload) return "";
    return weiToNumber(payload.amount, payload.decimals).toLocaleString(
      "en-US",
      { maximumFractionDigits: payload.decimals },
    );
  }, [payload]);

  const usdFmt = useMemo(() => {
    if (!payload || payload.priceUsd == null) return null;
    const usd = weiToNumber(payload.amount, payload.decimals) * payload.priceUsd;
    return usd.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }, [payload]);

  const onConfirm = async () => {
    if (!payload || !evmAddress) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    setError(null);

    try {
      const data = PAMPALO_IFACE.encodeFunctionData("cancelShield", [
        BigInt(payload.pendingId),
      ]);
      const nonceRes = await rpc.getNonce(payload.chainId, evmAddress);
      const useEip1559 = gas.priorityFeeWei !== undefined;
      const baseGasPriceWei = BigInt(gas.gasPriceWei);
      const maxPriorityFeePerGas =
        useEip1559 && gas.priorityFeeWei !== undefined
          ? BigInt(gas.priorityFeeWei)
          : undefined;
      const maxFeePerGas = useEip1559 ? baseGasPriceWei : undefined;
      const legacyGasPrice = useEip1559 ? undefined : baseGasPriceWei;

      setPhase("signing");
      const signed = await signTransactionWithPasskey({
        chainId: payload.chainId,
        to: payload.pampaloAddress,
        value: 0n,
        data,
        nonce: Number(nonceRes.nonce),
        gasLimit: CANCEL_GAS_LIMIT,
        gasPrice: legacyGasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      setPhase("submitting");
      const { txHash: hash } = await rpc.sendRawTransaction(
        payload.chainId,
        signed,
      );
      setTxHash(hash);

      // Optimistic: drop the note out of the pending list immediately. The
      // Convex→IDB sync will confirm the same transition once the indexer
      // sees ShieldCancelled.
      try {
        await patchNoteByLeaf(payload.leafCommitment, { state: "cancelled" });
      } catch {
        // non-fatal — sync will reconcile.
      }

      setPhase("awaiting");
      const startedAt = Date.now();
      for (;;) {
        if (isAborted()) return;
        if (Date.now() - startedAt > RECEIPT_TIMEOUT_MS) {
          toast(
            "Cancel submitted. Still waiting on the receipt — close this and check the explorer if it doesn't land soon.",
          );
          return;
        }
        try {
          const res = await rpc.getTransactionStatus(payload.chainId, hash);
          if (isAborted()) return;
          if (res.status === false) {
            setError("Cancel transaction reverted on-chain.");
            setPhase("error");
            return;
          }
          if (res.status === true && res.confirmations >= 1) {
            setPhase("confirmed");
            toast.success(
              `Shield cancelled. ${amountFmt} ${payload.symbol} refunded to your wallet.`,
            );
            return;
          }
        } catch {
          // transient — keep polling
        }
        await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("error");
    }
  };

  const isBusy =
    phase === "signing" || phase === "submitting" || phase === "awaiting";
  const closeable = phase !== "signing" && phase !== "submitting";
  const confirmDisabled = !payload || !evmAddress || isBusy || phase === "confirmed";

  const confirmLabel = (() => {
    switch (phase) {
      case "signing":
        return "Awaiting passkey…";
      case "submitting":
        return "Submitting cancel…";
      case "awaiting":
        return "Awaiting confirmation…";
      case "confirmed":
        return "Cancelled";
      case "error":
        return "Try again";
      default:
        return "Cancel shield";
    }
  })();

  const explorer = payload && txHash ? txUrl(payload.chainId, txHash) : null;

  const body = (
    <div className="flex flex-col">
      <header className="flex items-center gap-2 px-5 pt-3 sm:px-6 sm:pt-4">
        <span
          className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--pub-soft)] text-[var(--pub)]"
          aria-hidden
        >
          <XCircle className="size-4" />
        </span>
        <span className="font-serif text-[18px] font-bold text-ink">
          Cancel shield
        </span>
      </header>

      <div className="flex flex-col gap-4 px-5 pb-5 pt-4 sm:px-6">
        <div className="rounded-2xl border border-line bg-paper-lo px-4 py-3.5">
          <div className="flex items-center gap-3">
            {payload ? (
              <AssetMark symbol={payload.symbol} size={36} />
            ) : (
              <span className="skel size-9 rounded-full" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[15px] font-semibold text-ink">
                {payload ? `${amountFmt} ${payload.symbol}` : "—"}
              </div>
              {usdFmt && (
                <div className="text-[11.5px] text-ink-mute">≈ {usdFmt}</div>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
          This cancels your pending shield and refunds {amountFmt}{" "}
          {payload?.symbol} to your public wallet. Your monthly shield budget is
          credited back too.
        </div>

        {error && (
          <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
            {error}
          </div>
        )}

        <StatusLine phase={phase} explorer={explorer} />

        <div className="flex flex-col gap-2">
          {phase !== "confirmed" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className={cn(
                "inline-flex h-[56px] sm:h-[48px] w-full items-center justify-center gap-2",
                "rounded-full px-5 text-[14px] font-bold text-white shadow-sm",
                "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {isBusy && (
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              )}
              <span className="truncate">{confirmLabel}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={!closeable}
            className={cn(
              "inline-flex h-[42px] w-full items-center justify-center rounded-full",
              "border border-line bg-transparent px-5 text-[13.5px] font-semibold text-ink",
              "transition-colors hover:bg-paper-lo",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {phase === "confirmed" ? "Close" : "Keep shield"}
          </button>
        </div>
      </div>
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={closeable ? onOpenChange : () => {}}>
        <DialogContent className={cn("w-[460px] max-w-[calc(100%-2rem)] gap-0 p-0")}>
          <VisuallyHidden.Root>
            <DialogTitle>Cancel shield</DialogTitle>
          </VisuallyHidden.Root>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={closeable ? onOpenChange : () => {}}>
      <SheetContent side="bottom" className="gap-0 p-0">
        <VisuallyHidden.Root>
          <SheetTitle>Cancel shield</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function StatusLine({
  phase,
  explorer,
}: {
  phase: Phase;
  explorer: string | null;
}) {
  if (phase === "signing" || phase === "submitting" || phase === "awaiting") {
    const label =
      phase === "signing"
        ? "Awaiting passkey signature"
        : phase === "submitting"
          ? "Submitting cancel transaction"
          : "Awaiting confirmation";
    return (
      <div
        className="flex items-start gap-2.5 rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]"
        aria-live="polite"
      >
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{label}…</div>
          {explorer && phase === "awaiting" && (
            <a
              href={explorer}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-ink-soft underline-offset-2 hover:text-ink hover:underline"
            >
              View on explorer
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </div>
    );
  }
  if (phase === "confirmed") {
    return (
      <div
        className="flex items-start gap-2.5 rounded-xl border border-[var(--priv-soft-2)] bg-[var(--priv-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--priv)]"
        aria-live="polite"
      >
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Shield cancelled</div>
          <div className="mt-0.5 text-[11.5px] text-ink-mute">
            Your funds are back in your public wallet.
          </div>
          {explorer && (
            <a
              href={explorer}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-ink-soft underline-offset-2 hover:text-ink hover:underline"
            >
              View transaction
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </div>
    );
  }
  return null;
}

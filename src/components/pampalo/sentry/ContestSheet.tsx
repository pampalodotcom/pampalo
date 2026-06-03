import { useEffect, useMemo, useRef, useState } from "react";
import { Interface } from "ethers";
import { useQuery } from "convex/react";
import { CheckCircle2, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { txUrl } from "@/lib/explorer";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { signTransactionWithPasskey } from "@/lib/auth-flow";
import { useRpcClient } from "@/lib/rpc";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { Deployment } from "./ActionConfirmSheet";

// /sentry's Contest modal — reason field + tx broadcast. The passkey
// ceremony IS the confirmation step (no separate "are you sure?" before
// the WebAuthn prompt). See SHIELD_FLOW.md §10.5.

const REASON_MAX = 280;
// Contest path does a refund (`_refundEscrow` ETH `.call`, or ERC20
// transfer) + cap refund + event emit. ETH refund + state writes
// comfortably fits under 200k; with the variable reason field we leave
// generous headroom.
const CONTEST_GAS_LIMIT = 300_000n;

const PAMPALO_IFACE = new Interface([
  "function contestShield(uint256 id, string reason) external",
]);

export type ContestPayload = {
  row: Doc<"shieldQueueEntries">;
};

type Phase =
  | "idle"
  | "signing"
  | "submitting"
  | "awaiting"
  | "confirmed"
  | "error";

const RECEIPT_POLL_MS = 2_500;
const RECEIPT_TIMEOUT_MS = 60_000;

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: ContestPayload | null;
  evmAddress: string | null;
  deployments: Deployment[];
};

export function ContestSheet({
  open,
  onOpenChange,
  payload,
  evmAddress,
  deployments,
}: Props) {
  const isDesktop = useIsDesktop();
  const rpc = useRpcClient();

  const deployment = useMemo(() => {
    if (!payload) return null;
    return deployments.find((d) => d._id === payload.row.deploymentId) ?? null;
  }, [deployments, payload]);

  const gas = useQuery(
    api.prices.gas.latestForChain,
    deployment ? { chainId: deployment.chainId } : "skip",
  );

  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Cancellation flag for the receipt poller — flipped on close so a
  // late receipt doesn't try to setState on an unmounted sheet.
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setReason("");
      setPhase("idle");
      setError(null);
      setTxHash(null);
      cancelRef.current = true;
    } else {
      cancelRef.current = false;
    }
  }, [open]);

  const trimmed = reason.trim();
  const reasonValid = trimmed.length > 0 && trimmed.length <= REASON_MAX;

  const onConfirm = async () => {
    if (!payload || !deployment || !evmAddress) return;
    if (!reasonValid) {
      setError("Reason is required (1–280 characters).");
      return;
    }
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    setError(null);

    try {
      const data = PAMPALO_IFACE.encodeFunctionData("contestShield", [
        BigInt(payload.row.pendingId),
        trimmed,
      ]);

      const nonceRes = await rpc.getNonce(deployment.chainId, evmAddress);
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
        chainId: deployment.chainId,
        to: deployment.pampaloAddress,
        value: 0n,
        data,
        nonce: Number(nonceRes.nonce),
        gasLimit: CONTEST_GAS_LIMIT,
        gasPrice: legacyGasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      setPhase("submitting");
      const { txHash: hash } = await rpc.sendRawTransaction(
        deployment.chainId,
        signed,
      );
      setTxHash(hash);

      // Hold the sheet through the on-chain receipt so the user gets
      // an explicit "Contested" beat instead of the sheet vanishing
      // and a toast being the only signal. Bail out cleanly on close
      // or after the global timeout.
      setPhase("awaiting");
      const startedAt = Date.now();
      while (!cancelRef.current) {
        if (Date.now() - startedAt > RECEIPT_TIMEOUT_MS) {
          toast(
            "Contest submitted. Still waiting on the receipt — close this and check the explorer if it doesn't land soon.",
          );
          return;
        }
        try {
          const res = await rpc.getTransactionStatus(deployment.chainId, hash);
          if (cancelRef.current) return;
          if (res.status === false) {
            setError("Contest transaction reverted on-chain.");
            setPhase("error");
            return;
          }
          if (res.status === true && res.confirmations >= 1) {
            setPhase("confirmed");
            toast.success("Shield contested. The shielder has been refunded.");
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
  // While the on-chain receipt is being polled the user can close — the
  // poll's cancellation flag ensures stale results are dropped. Block
  // close only during the signing + broadcast window where a back-out
  // would leave a half-sent tx.
  const closeable = phase !== "signing" && phase !== "submitting";
  const confirmDisabled =
    !payload ||
    !deployment ||
    !evmAddress ||
    !reasonValid ||
    isBusy ||
    phase === "confirmed";

  const confirmLabel = (() => {
    switch (phase) {
      case "signing":
        return "Awaiting passkey…";
      case "submitting":
        return "Submitting contest…";
      case "awaiting":
        return "Awaiting confirmation…";
      case "confirmed":
        return "Contested";
      case "error":
        return "Try again";
      default:
        return "Contest shield";
    }
  })();

  const explorer =
    deployment && txHash ? txUrl(deployment.chainId, txHash) : null;

  const body = (
    <div className="flex flex-col">
      <header className="flex items-center justify-between px-5 pt-3 sm:px-6 sm:pt-4">
        <div className="inline-flex items-center gap-2">
          <span
            className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--pub-soft)] text-[var(--pub)]"
            aria-hidden
          >
            <ShieldAlert className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Contest shield
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5 pb-5 pt-4 sm:px-6">
        <div className="rounded-2xl border border-line bg-paper-lo px-4 py-3.5">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            <dt className="text-ink-mute">Pending id</dt>
            <dd className="font-mono text-ink">
              {payload?.row.pendingId ?? "—"}
            </dd>
            <dt className="text-ink-mute">Shielder</dt>
            <dd className="font-mono text-ink">
              {payload ? shortAddress(payload.row.shielder) : "—"}
            </dd>
            <dt className="text-ink-mute">Asset</dt>
            <dd className="font-mono text-ink">
              {payload ? shortAddress(payload.row.asset) : "—"}
            </dd>
            <dt className="text-ink-mute">Amount</dt>
            <dd className="font-mono text-ink">{payload?.row.amount ?? "—"}</dd>
            <dt className="text-ink-mute">Network</dt>
            <dd className="font-mono text-ink">
              {deployment?.networkName ?? "—"}
            </dd>
          </dl>
        </div>

        <div>
          <label
            htmlFor="contest-reason"
            className="block text-[11.5px] font-semibold uppercase tracking-[0.1em] text-ink-mute"
          >
            Reason · public, on-chain, max {REASON_MAX}
          </label>
          <textarea
            id="contest-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isBusy || phase === "confirmed"}
            placeholder="e.g. Source address appears on the OFAC SDN list…"
            className={cn(
              "mt-1.5 block w-full resize-y rounded-xl border border-line",
              "bg-paper px-3 py-2.5 text-[13px] text-ink",
              "focus:outline-none focus:ring-2 focus:ring-[var(--pub-soft-2)]",
              "min-h-[88px]",
            )}
            maxLength={REASON_MAX}
          />
          <div className="mt-1 text-right font-mono text-[10.5px] text-ink-mute">
            {trimmed.length} / {REASON_MAX}
          </div>
        </div>

        <div
          className={cn(
            "rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5",
            "text-[12.5px] text-[var(--pub)]",
          )}
        >
          ⚠ This refunds the shielder and emits your reason publicly on-chain.
          The action is irreversible.
        </div>

        {error && (
          <div
            className={cn(
              "rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5",
              "text-[12.5px] text-[var(--pub)]",
            )}
          >
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
              "border border-line bg-transparent px-5",
              "text-[13.5px] font-semibold text-ink",
              "transition-colors hover:bg-paper-lo",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {phase === "confirmed" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={closeable ? onOpenChange : () => {}}>
        <DialogContent
          className={cn("w-[520px] max-w-[calc(100%-2rem)] gap-0 p-0")}
        >
          <VisuallyHidden.Root>
            <DialogTitle>Contest shield</DialogTitle>
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
          <SheetTitle>Contest shield</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function shortAddress(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function StatusLine({
  phase,
  explorer,
}: {
  phase: Phase;
  explorer: string | null;
}) {
  if (phase === "signing") {
    return (
      <ProgressLine
        label="Awaiting passkey signature"
        sub="Approve the passkey prompt to decrypt your mnemonic and sign the contest locally."
      />
    );
  }
  if (phase === "submitting") {
    return (
      <ProgressLine
        label="Submitting contest transaction"
        sub="Broadcasting the signed contest to the network."
      />
    );
  }
  if (phase === "awaiting") {
    return (
      <ProgressLine
        label="Awaiting confirmation"
        sub="Waiting for the on-chain receipt. The shielder will be refunded once it mines."
        explorer={explorer}
      />
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
          <div className="font-semibold">Contest confirmed on-chain</div>
          <div className="mt-0.5 text-[11.5px] text-ink-mute">
            The shielder has been refunded and your reason is now part of the
            public record.
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

function ProgressLine({
  label,
  sub,
  explorer,
}: {
  label: string;
  sub?: string;
  explorer?: string | null;
}) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]"
      aria-live="polite"
    >
      <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{label}…</div>
        {sub && <div className="mt-0.5 text-[11.5px] text-ink-mute">{sub}</div>}
        {explorer && (
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

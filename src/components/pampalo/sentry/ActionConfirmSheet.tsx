import { useEffect, useMemo, useState } from "react";
import { Interface } from "ethers";
import { useQuery } from "convex/react";
import { CheckCircle2, Clock3, ExternalLink, Loader2, Zap } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { signTransactionWithPasskey } from "@/lib/auth-flow";
import { txUrl } from "@/lib/explorer";
import { useRpcClient } from "@/lib/rpc";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

// Shared confirm sheet for /sentry's parameter-less actions:
//   - "sponsor": calls Pampalo.executeShield(id) — anyone, post-unlock.
//   - "fastTrack": calls Pampalo.executeShieldImmediate(id) — booth role.
//
// Contest gets its own sheet (it takes a reason field; see ContestSheet).
//
// Same phase machine + responsive Dialog/Sheet pattern as
// ShieldConfirmSheet — broadcasts on signed (no "stop before submit"
// pause; the indexer will pick up the resulting event within ~30s and
// the reactive query will flip the row's state).

// Both actions call into PoseidonMerkleTree._insert, which staticcalls the
// Poseidon2 huff hasher once per tree level (~31 times). That hash loop costs
// ~605k gas measured via eth_estimateGas; the old 250k cap ran the inner
// staticcall out of gas, which surfaces as a "Poseidon2 hash failed" revert
// (hashLeftRight forwards all gas, then require(success)) rather than a clean
// out-of-gas. EVM charges gasUsed, not the limit, so the headroom is free —
// keep it well clear of the real cost.
const ACTION_GAS_LIMIT = 2_000_000n;

const PAMPALO_IFACE = new Interface([
  "function executeShield(uint256 id) external",
  "function executeShieldImmediate(uint256 id) external",
]);

export type ActionKind = "sponsor" | "fastTrack";

export type ActionConfirmPayload = {
  kind: ActionKind;
  row: Doc<"shieldQueueEntries">;
};

export type Deployment = {
  _id: Id<"pampaloDeployments">;
  chainId: number;
  networkName: string;
  pampaloAddress: string;
  shieldWaitSeconds: number;
};

// Phase machine. "submitted" is the optimistic post-broadcast state —
// we've got a txHash but no receipt yet, so the success panel shows a
// loading spinner over "Inserting into the merkle tree…". When the
// receipt polls back successful we flip to "confirmed" (final).
type Phase =
  | "idle"
  | "signing"
  | "broadcasting"
  | "submitted"
  | "confirmed"
  | "error";

const POLL_INTERVAL_MS = 2_500;
const CONFIRMATIONS_NEEDED = 1;

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: ActionConfirmPayload | null;
  evmAddress: string | null;
  deployments: Deployment[];
  /** Called once when the broadcast succeeds — passes the row's
   *  Convex `_id` so the parent can mark it as Finalising in the
   *  shield queue table until the indexer reconciles. */
  onSubmitted?: (rowId: string) => void;
};

export function ActionConfirmSheet({
  open,
  onOpenChange,
  payload,
  evmAddress,
  deployments,
  onSubmitted,
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

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setError(null);
      setTxHash(null);
      setBlockNumber(null);
    }
  }, [open]);

  // Receipt polling for the celebratory success panel. Runs while phase
  // is "submitted" and we have a txHash; flips to "confirmed" on the
  // first successful receipt with ≥CONFIRMATIONS_NEEDED, or back to
  // "error" if the tx reverts. Cleanup on unmount / close stops the
  // poll loop.
  useEffect(() => {
    if (phase !== "submitted" || !txHash || !deployment) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await rpc.getTransactionStatus(deployment.chainId, txHash);
        if (cancelled) return;
        if (res.status === false) {
          setError("Transaction reverted on-chain.");
          setPhase("error");
          return;
        }
        if (res.status === true && res.confirmations >= CONFIRMATIONS_NEEDED) {
          setBlockNumber(res.blockNumber);
          setPhase("confirmed");
          return;
        }
      } catch {
        // Transient RPC error — keep polling.
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, txHash, deployment, rpc]);

  const onConfirm = async () => {
    if (!payload || !deployment || !evmAddress) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet - try again in a moment.");
      return;
    }
    setError(null);

    try {
      const method =
        payload.kind === "fastTrack"
          ? "executeShieldImmediate"
          : "executeShield";
      const data = PAMPALO_IFACE.encodeFunctionData(method, [
        BigInt(payload.row.pendingId),
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
        gasLimit: ACTION_GAS_LIMIT,
        gasPrice: legacyGasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      setPhase("broadcasting");
      const { txHash: hash } = await rpc.sendRawTransaction(
        deployment.chainId,
        signed,
      );
      setTxHash(hash);
      setPhase("submitted");
      onSubmitted?.(payload.row._id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("error");
    }
  };

  const inFlight = phase === "signing" || phase === "broadcasting";
  const closeable = !inFlight;
  const isSuccessPanel = phase === "submitted" || phase === "confirmed";
  const confirmDisabled =
    !payload || !deployment || !evmAddress || inFlight || isSuccessPanel;

  const isFastTrack = payload?.kind === "fastTrack";

  const titleText = isFastTrack ? "Fast-track shield" : "Sponsor finalise";

  // Fire a tasteful success toast once on the optimistic-submit flip
  // and a confirmation toast on receipt. The sheet itself keeps the
  // celebratory state alive — the toast is the "background-ack" copy
  // for users who close the sheet immediately.
  useEffect(() => {
    if (phase !== "submitted") return;
    toast.success(
      isFastTrack
        ? "Fast-tracked - inserting into the merkle tree…"
        : "Sponsored - awaiting confirmation…",
    );
  }, [phase, isFastTrack]);
  useEffect(() => {
    if (phase !== "confirmed") return;
    toast.success(
      isFastTrack
        ? "Leaf in the tree. Note is spendable."
        : "Shield finalised. Note is spendable.",
    );
  }, [phase, isFastTrack]);

  const confirmLabel = (() => {
    switch (phase) {
      case "signing":
        return "Awaiting passkey…";
      case "broadcasting":
        return "Broadcasting…";
      case "error":
        return "Try again";
      default:
        return isFastTrack ? "Fast-track" : "Sponsor finalise";
    }
  })();

  const body = (
    <div className="flex flex-col">
      <header className="flex items-center justify-between px-5 pt-3 sm:px-6 sm:pt-4">
        <div className="inline-flex items-center gap-2">
          <span
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-lg",
              isFastTrack
                ? "bg-[var(--pub-soft)] text-[var(--pub)]"
                : "bg-[var(--priv-soft)] text-[var(--priv)]",
            )}
            aria-hidden
          >
            {isFastTrack ? (
              <Zap className="size-4" />
            ) : (
              <Clock3 className="size-4" />
            )}
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            {titleText}
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5 pb-5 pt-4 sm:px-6">
        {isSuccessPanel ? (
          <SuccessPanel
            kind={payload?.kind ?? "fastTrack"}
            phase={phase}
            txHash={txHash}
            chainId={deployment?.chainId ?? null}
            blockNumber={blockNumber}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <>
            {/* Summary */}
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
                <dd className="font-mono text-ink">
                  {payload?.row.amount ?? "—"}
                </dd>
                <dt className="text-ink-mute">Network</dt>
                <dd className="font-mono text-ink">
                  {deployment?.networkName ?? "—"}
                </dd>
              </dl>
            </div>

            {/* Warning copy varies by kind. */}
            {isFastTrack ? (
              <div
                className={cn(
                  "rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5",
                  "text-[12.5px] text-[var(--pub)]",
                )}
              >
                ⚠ Fast-track skips the 1-hour compliance wait. The leaf will be
                inserted into the merkle tree immediately. Booth-event use only.
              </div>
            ) : (
              <div className="text-[12.5px] text-ink-mute">
                You will pay gas to finalise this shield on behalf of the
                shielder. After confirmation the leaf is inserted into the
                merkle tree and the note becomes spendable.
              </div>
            )}

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

            {/* Action stack — same Confirm-on-top pattern as ShieldConfirmSheet. */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onConfirm}
                disabled={confirmDisabled}
                className={cn(
                  "inline-flex h-[56px] sm:h-[48px] w-full items-center justify-center gap-2",
                  "rounded-full px-5 text-[14px] font-bold text-white shadow-sm",
                  isFastTrack
                    ? "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]"
                    : "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {inFlight && (
                  <Loader2
                    className="size-4 shrink-0 animate-spin"
                    aria-hidden
                  />
                )}
                <span className="truncate">{confirmLabel}</span>
              </button>
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
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={closeable ? onOpenChange : () => {}}>
        <DialogContent
          className={cn("w-[480px] max-w-[calc(100%-2rem)] gap-0 p-0")}
        >
          <VisuallyHidden.Root>
            <DialogTitle>{titleText}</DialogTitle>
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
          <SheetTitle>{titleText}</SheetTitle>
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

// ─── Success / pending panel ────────────────────────────────────────────
// Stays open after broadcast so the user gets an honest "submitted but
// not yet mined" optimistic state, then flips to the confirmed pose
// once we have a receipt. Same visual treatment for fast-track and
// sponsor; copy varies.

function SuccessPanel({
  kind,
  phase,
  txHash,
  chainId,
  blockNumber,
  onClose,
}: {
  kind: ActionKind;
  phase: "submitted" | "confirmed";
  txHash: string | null;
  chainId: number | null;
  blockNumber: number | null;
  onClose: () => void;
}) {
  const isFastTrack = kind === "fastTrack";
  const isConfirmed = phase === "confirmed";
  const explorer = txHash && chainId ? txUrl(chainId, txHash) : null;

  const headline = isConfirmed
    ? isFastTrack
      ? "Fast-tracked!"
      : "Shield finalised!"
    : isFastTrack
      ? "Fast-tracking…"
      : "Sponsoring…";

  const subcopy = isConfirmed
    ? "Leaf inserted into the merkle tree. The note is now spendable."
    : isFastTrack
      ? "Your transaction is on its way to the tree. Hang tight."
      : "Waiting for the receipt — should land in a few seconds.";

  return (
    <div className="flex flex-col items-center gap-4 px-2 pt-2 text-center">
      {/* Halo + icon — soft pulse on the disk + a slow ping ring while
          pending, static "ready" pose when confirmed. The previous
          compose stacked a spinning Loader2 on top of a Sparkles at
          40% opacity, which read as broken (the two icons clashed). */}
      <div className="relative inline-flex size-16 items-center justify-center">
        {!isConfirmed && (
          <span
            className={cn(
              "absolute inset-0 rounded-full opacity-60",
              isFastTrack
                ? "bg-[var(--pub-soft-2)]"
                : "bg-[var(--priv-soft-2)]",
              "animate-ping",
            )}
            aria-hidden
          />
        )}
        <span
          className={cn(
            "absolute inset-0 rounded-full",
            isFastTrack ? "bg-[var(--pub-soft)]" : "bg-[var(--priv-soft)]",
            !isConfirmed && "animate-pulse",
          )}
          aria-hidden
        />
        {isConfirmed ? (
          <CheckCircle2
            className={cn(
              "relative size-10",
              isFastTrack ? "text-[var(--pub)]" : "text-[var(--priv)]",
            )}
            aria-hidden
          />
        ) : isFastTrack ? (
          <Zap
            className={cn("relative size-8", "text-[var(--pub)]")}
            aria-hidden
          />
        ) : (
          <Clock3
            className={cn("relative size-8", "text-[var(--priv)]")}
            aria-hidden
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="font-serif text-[20px] font-bold text-ink">
          {headline}
        </h3>
        <p className="text-[13px] text-ink-mute max-w-[340px]">{subcopy}</p>
      </div>

      {/* Footer chip + explorer link. Always render the row so the
          panel doesn't reflow when the receipt lands. */}
      <div className="mt-1 flex flex-col items-center gap-2">
        {isConfirmed && blockNumber !== null && (
          <p className="text-[11.5px] text-ink-mute font-mono">
            Confirmed in block #{blockNumber.toLocaleString("en-US")}
          </p>
        )}
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full",
              "border border-line bg-paper-lo px-3 py-1.5",
              "text-[12px] font-semibold text-ink-soft",
              "transition-colors hover:bg-paper hover:text-ink",
            )}
          >
            View transaction
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className={cn(
          "mt-2 inline-flex h-[44px] w-full items-center justify-center rounded-full",
          isConfirmed
            ? cn(
                "text-white shadow-sm font-bold text-[14px]",
                isFastTrack
                  ? "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]"
                  : "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
              )
            : "border border-line bg-transparent text-[13.5px] font-semibold text-ink hover:bg-paper-lo",
        )}
      >
        {isConfirmed ? "Done" : "Close"}
      </button>
    </div>
  );
}

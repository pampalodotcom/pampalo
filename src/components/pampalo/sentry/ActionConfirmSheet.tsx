import { useEffect, useMemo, useState } from "react";
import { Interface } from "ethers";
import { useQuery } from "convex/react";
import { Clock3, Loader2, Zap } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { signTransactionWithPasskey } from "@/lib/auth-flow";
import { useRpcClient } from "@/lib/rpc";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
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

const ACTION_GAS_LIMIT = 250_000n;

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

type Phase = "idle" | "signing" | "broadcasting" | "done" | "error";

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: ActionConfirmPayload | null;
  evmAddress: string | null;
  deployments: Deployment[];
};

export function ActionConfirmSheet({
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
    return (
      deployments.find((d) => d._id === payload.row.deploymentId) ?? null
    );
  }, [deployments, payload]);

  const gas = useQuery(
    api.prices.gas.latestForChain,
    deployment ? { chainId: deployment.chainId } : "skip",
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setError(null);
    }
  }, [open]);

  const onConfirm = async () => {
    if (!payload || !deployment || !evmAddress) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
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
      await rpc.sendRawTransaction(deployment.chainId, signed);
      setPhase("done");
      toast.success(
        payload.kind === "fastTrack"
          ? "Fast-tracked. Leaf inserted into the merkle tree."
          : "Sponsored. The shielder's note is on its way to the tree.",
      );
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("error");
    }
  };

  const closeable = phase !== "signing" && phase !== "broadcasting";
  const confirmDisabled =
    !payload ||
    !deployment ||
    !evmAddress ||
    phase === "signing" ||
    phase === "broadcasting" ||
    phase === "done";

  const isFastTrack = payload?.kind === "fastTrack";

  const titleText = isFastTrack ? "Fast-track shield" : "Sponsor finalise";

  const confirmLabel = (() => {
    switch (phase) {
      case "signing":
        return "Awaiting passkey…";
      case "broadcasting":
        return "Broadcasting…";
      case "done":
        return "Done";
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
            <dd className="font-mono text-ink">{payload?.row.amount ?? "—"}</dd>
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
          {phase !== "done" && (
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
              {(phase === "signing" || phase === "broadcasting") && (
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
            Cancel
          </button>
        </div>
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

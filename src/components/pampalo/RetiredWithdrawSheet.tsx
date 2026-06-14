import { useEffect, useMemo, useState } from "react";
import { Loader2, Sun } from "lucide-react";
import { useQuery } from "convex/react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { withUnlockedWallet } from "@/lib/auth-flow";
import { patchNoteByLeaf } from "@/lib/idb-notes";
import { useRpcClient } from "@/lib/rpc";
import { useRetiredTree } from "@/lib/use-retired-tree";
import {
  prepareRetiredWithdrawal,
  type RetiredNote,
} from "@/lib/withdraw-retired";
import { normalizeBroadcastError } from "@/lib/broadcast-error";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AssetMark } from "./AssetMark";

// ADR 0022 — "Withdraw to wallet" for a retired deployment's notes. Each note
// is an independent `unshieldBundled` against the OLD contract, exiting its
// full amount to the user's own EVM address (self-broadcast — a retired
// contract is never in the sponsoring set). Multiple notes of one asset are
// signed under a single passkey unlock and broadcast in nonce order.
//
// The old contract must be in retirement wind-down (DEPLOYMENT.md / ADR 0022:
// `weAreFull()` + `setDefaultMonthlyCap(huge)`) or an over-cap note reverts.

const WITHDRAW_GAS_LIMIT = 8_000_000n;

type Phase = "idle" | "preparing" | "signing" | "submitting" | "done" | "error";

export type RetiredWithdrawPayload = {
  chainId: number;
  /** Lowercased OLD (retired) Pampalo address. */
  deploymentAddress: string;
  asset: string; // lowercased
  symbol: string;
  decimals: number;
  /** All withdrawable notes for this (deployment, asset). */
  notes: RetiredNote[];
};

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: RetiredWithdrawPayload | null;
  addresses: { evm: string; envelope: string; poseidon: string };
  /** Notify the parent so it can refresh / lock while receipts mine. */
  onWithdrawn?: (info: { chainId: number; txHashes: string[] }) => void;
};

export function RetiredWithdrawSheet({
  open,
  onOpenChange,
  payload,
  addresses,
  onWithdrawn,
}: Props) {
  const isDesktop = useIsDesktop();
  const rpc = useRpcClient();

  const retired = useRetiredTree(
    payload?.chainId ?? null,
    payload?.deploymentAddress ?? null,
    open,
  );
  const gas = useQuery(
    api.prices.gas.latestForChain,
    payload ? { chainId: payload.chainId } : "skip",
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setError(null);
      setDone(0);
    }
  }, [open]);

  const count = payload?.notes.length ?? 0;
  const totalFmt = useMemo(() => {
    if (!payload) return "";
    const total = payload.notes.reduce((a, n) => a + BigInt(n.amount), 0n);
    const whole = Number(total) / 10 ** payload.decimals;
    return whole.toLocaleString("en-US", {
      maximumFractionDigits: payload.decimals,
    });
  }, [payload]);

  const onConfirm = async () => {
    if (!payload) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    if (!retired.tree) {
      setError("Rebuilding the previous contract's tree — try again shortly.");
      return;
    }
    setError(null);
    setDone(0);

    try {
      // Sign every note's withdrawal under one passkey unlock.
      setPhase("signing");
      const signedTxs = await withUnlockedWallet(async (wallet) => {
        setPhase("preparing");
        const startNonce = Number(
          (await rpc.getNonce(payload.chainId, addresses.evm)).nonce,
        );
        const useEip1559 = gas.priorityFeeWei !== undefined;
        const baseGasPriceWei = BigInt(gas.gasPriceWei);

        const out: string[] = [];
        for (let i = 0; i < payload.notes.length; i += 1) {
          const note = payload.notes[i];
          const prep = await prepareRetiredWithdrawal({
            chainId: payload.chainId,
            oldPampalo: payload.deploymentAddress,
            note,
            tree: retired.tree!,
            commitmentToLeafIndex: retired.commitmentToLeafIndex,
            exitAddress: addresses.evm,
            walletPrivateKey: wallet.privateKey,
            selfPoseidon: addresses.poseidon,
            selfEnvelopePubKey: addresses.envelope,
          });
          const signed = await wallet.signTransaction({
            chainId: payload.chainId,
            to: prep.to,
            value: 0n,
            data: prep.data,
            nonce: startNonce + i,
            gasLimit: WITHDRAW_GAS_LIMIT,
            gasPrice: useEip1559 ? undefined : baseGasPriceWei,
            maxFeePerGas: useEip1559 ? baseGasPriceWei : undefined,
            maxPriorityFeePerGas:
              useEip1559 && gas.priorityFeeWei !== undefined
                ? BigInt(gas.priorityFeeWei)
                : undefined,
            type: useEip1559 ? 2 : undefined,
          });
          out.push(signed);
        }
        return out;
      });

      // Broadcast in nonce order; patch each note spent as it lands.
      setPhase("submitting");
      const txHashes: string[] = [];
      for (let i = 0; i < signedTxs.length; i += 1) {
        const { txHash } = await rpc.sendRawTransaction(
          payload.chainId,
          signedTxs[i],
        );
        txHashes.push(txHash);
        try {
          await patchNoteByLeaf(payload.notes[i].leafCommitment, {
            state: "spent",
            spentTxHash: txHash,
          });
        } catch (idbErr) {
          console.warn("[retired-withdraw] optimistic IDB patch failed", idbErr);
        }
        setDone(i + 1);
      }

      onWithdrawn?.({ chainId: payload.chainId, txHashes });
      toast.success(
        `Withdrew ${totalFmt} ${payload.symbol} from a previous contract`,
      );
      setPhase("done");
      await new Promise((r) => setTimeout(r, 700));
      onOpenChange(false);
    } catch (e) {
      const n = normalizeBroadcastError(e);
      setError(n.friendly);
      setPhase("error");
    }
  };

  const isBusy =
    phase === "preparing" || phase === "signing" || phase === "submitting";
  const closeable = !isBusy;
  const confirmDisabled = !payload || isBusy || phase === "done";

  const confirmLabel = (() => {
    switch (phase) {
      case "preparing":
        return "Generating proof…";
      case "signing":
        return "Awaiting passkey…";
      case "submitting":
        return count > 1
          ? `Withdrawing ${done}/${count}…`
          : "Submitting withdrawal…";
      case "done":
        return "Done";
      case "error":
        return "Try again";
      default:
        return payload ? `Withdraw ${totalFmt} ${payload.symbol}` : "Withdraw";
    }
  })();

  const body = (
    <div className="flex flex-col">
      <header className="flex items-center justify-between px-5 pt-3 sm:px-6 sm:pt-4">
        <div className="inline-flex items-center gap-2">
          <span
            className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--pub-soft)] text-[var(--pub)]"
            aria-hidden
          >
            <Sun className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Withdraw to wallet
          </span>
        </div>
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
                {payload ? `${totalFmt} ${payload.symbol}` : "—"}
              </div>
              <div className="text-[11.5px] text-ink-mute">
                From a previous contract version back to your public wallet
                {count > 1 ? ` · ${count} notes (one tx each)` : ""}.
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-3 text-[11.5px]">
            <div>
              <div className="text-ink-mute">Previous contract</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-ink">
                {payload?.deploymentAddress ?? "…"}
              </div>
            </div>
            <div>
              <div className="text-ink-mute">Withdrawing to</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-ink">
                {addresses.evm}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {phase !== "done" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className={cn(
                "inline-flex h-[56px] sm:h-[48px] w-full items-center justify-center gap-2",
                "rounded-full px-5 text-[14px] font-bold text-white",
                "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
                "shadow-sm transition-opacity",
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
            {phase === "done" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={closeable ? onOpenChange : () => {}}>
        <DialogContent className={cn("w-[480px] max-w-[calc(100%-2rem)] gap-0 p-0")}>
          <VisuallyHidden.Root>
            <DialogTitle>Withdraw to wallet</DialogTitle>
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
          <SheetTitle>Withdraw to wallet</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

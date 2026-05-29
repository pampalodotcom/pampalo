import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Loader2, Sun, ShieldOff } from "lucide-react";
import { useQuery } from "convex/react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { withUnlockedWallet } from "@/lib/auth-flow";
import { ETH_SENTINEL } from "@/lib/eth";
import {
  appendNote,
  getNotesSnapshot,
  isNotesHydrated,
  patchNoteByLeaf,
  subscribeNotes,
  type StoredNote,
} from "@/lib/idb-notes";
import { prepareUnshield } from "@/lib/unshield-prep";
import { useRpcClient } from "@/lib/rpc";
import { useIsDesktop } from "@/lib/use-media-query";
import { useMerkleTree } from "@/lib/use-merkle-tree";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AssetMark } from "../AssetMark";

// Slider-driven unshield. Mirror of ShieldConfirmSheet — same phase
// machine, same celebratory done-state, same dialog/sheet responsive
// pair. Uses prepareUnshield (transfer_external circuit via
// unshieldBundled) so the input note's change-to-self stays shielded
// in a single proof.
//
// Demo scope:
//   - Single input note that covers the unshield amount (auto-picked
//     from IDB). Multi-input join is future.
//   - Exits to msg.sender (the user's own EVM). Picking a different
//     recipient lands when the cross-recipient unshield UX does.
//   - Self-broadcast via the one-PRF withUnlockedWallet helper.

const UNSHIELD_GAS_LIMIT = 8_000_000n;

type Phase =
  | "idle"
  | "preparing"
  | "signing"
  | "submitting"
  | "awaiting"
  | "done"
  | "error";

export type UnshieldConfirmPayload = {
  intent: "unshield";
  /** Amount to send to the public side, in base units. */
  amount: bigint;
  chainId: number;
  symbol: string;
  decimals: number;
};

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: UnshieldConfirmPayload | null;
  addresses: {
    evm: string;
    envelope: string;
    poseidon: string;
  };
  /** See ShieldConfirmSheet.Props.onBroadcasted — same shape, lets
   *  the wallet register a (chainId, asset) lock while the receipt
   *  mines. */
  onBroadcasted?: (info: {
    chainId: number;
    assetAddress: string;
    txHash: string;
  }) => void;
};

export function UnshieldConfirmSheet({
  open,
  onOpenChange,
  payload,
  addresses,
  onBroadcasted,
}: Props) {
  const isDesktop = useIsDesktop();
  const rpc = useRpcClient();

  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const gas = useQuery(
    api.prices.gas.latestForChain,
    payload ? { chainId: payload.chainId } : "skip",
  );
  const merkle = useMerkleTree(payload?.chainId ?? null, open);

  const notes = useSyncExternalStore(
    subscribeNotes,
    getNotesSnapshot,
    () => getNotesSnapshot(),
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signedTx, setSignedTx] = useState<string | null>(null);
  const [broadcastedTxHash, setBroadcastedTxHash] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setError(null);
      setSignedTx(null);
      setBroadcastedTxHash(null);
    }
  }, [open]);

  const deployment = useMemo(() => {
    if (!payload || !deployments) return null;
    return deployments.find((d) => d.chainId === payload.chainId) ?? null;
  }, [deployments, payload]);

  const amountFmt = useMemo(() => {
    if (!payload) return "";
    const whole = Number(payload.amount) / 10 ** payload.decimals;
    return whole.toLocaleString("en-US", {
      maximumFractionDigits: payload.decimals,
    });
  }, [payload]);

  // Auto-pick the first spendable note on the right (chain, asset)
  // whose amount covers the exit. Single-input demo path.
  const inputNote = useMemo<StoredNote | null>(() => {
    if (!payload) return null;
    if (!isNotesHydrated()) return null;
    return (
      notes.find(
        (n) =>
          n.state === "spendable" &&
          n.networkChainId === payload.chainId &&
          n.asset === ETH_SENTINEL &&
          n.leafIndex !== undefined &&
          BigInt(n.amount) >= payload.amount,
      ) ?? null
    );
  }, [payload, notes]);

  const onConfirm = async () => {
    if (!payload || !deployment) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    if (!merkle.tree) {
      setError("Merkle tree still loading — try again in a moment.");
      return;
    }
    if (!inputNote) {
      setError(
        "No spendable shielded note covers this amount. Try a smaller drag or shield more first.",
      );
      return;
    }
    setError(null);

    try {
      setPhase("signing");
      const { prep, signed } = await withUnlockedWallet(async (wallet) => {
        setPhase("preparing");
        const prep = await prepareUnshield({
          chainId: payload.chainId,
          pampaloAddress: deployment.pampaloAddress,
          inputNote: {
            asset: inputNote.asset,
            amount: BigInt(inputNote.amount),
            secret: inputNote.secret,
            owner: inputNote.owner,
            leafIndex: inputNote.leafIndex!,
          },
          exitAddress: addresses.evm,
          exitAmount: payload.amount,
          walletPrivateKey: wallet.privateKey,
          selfPoseidon: addresses.poseidon,
          selfEnvelopePubKey: addresses.envelope,
          tree: merkle.tree!,
        });

        console.groupCollapsed(
          `%c[unshield-prep]%c proof ready on chain ${payload.chainId}`,
          "color:#0a7;font-weight:bold",
          "color:inherit",
        );
        console.log("input", {
          leafCommitment: inputNote.leafCommitment,
          leafIndex: inputNote.leafIndex,
          amount: inputNote.amount,
        });
        console.log("exit", prep.exit);
        console.log("changeOutput", prep.changeOutput);
        console.log("publicInputs", prep.publicInputs);
        console.log("spentNullifier", prep.spentNullifier);
        console.log("tx", {
          to: prep.to,
          value: prep.value,
          gasLimit: UNSHIELD_GAS_LIMIT.toString(),
          dataLength: prep.data.length,
          data: prep.data,
        });
        console.groupEnd();

        const nonceRes = await rpc.getNonce(payload.chainId, addresses.evm);
        const useEip1559 = gas.priorityFeeWei !== undefined;
        const baseGasPriceWei = BigInt(gas.gasPriceWei);
        const maxPriorityFeePerGas =
          useEip1559 && gas.priorityFeeWei !== undefined
            ? BigInt(gas.priorityFeeWei)
            : undefined;
        const maxFeePerGas = useEip1559 ? baseGasPriceWei : undefined;
        const legacyGasPrice = useEip1559 ? undefined : baseGasPriceWei;

        const signed = await wallet.signTransaction({
          chainId: payload.chainId,
          to: prep.to,
          value: 0n,
          data: prep.data,
          nonce: Number(nonceRes.nonce),
          gasLimit: UNSHIELD_GAS_LIMIT,
          gasPrice: useEip1559 ? undefined : legacyGasPrice,
          maxFeePerGas: useEip1559 ? maxFeePerGas : undefined,
          maxPriorityFeePerGas: useEip1559 ? maxPriorityFeePerGas : undefined,
          type: useEip1559 ? 2 : undefined,
        });
        return { prep, signed };
      });
      setSignedTx(signed);

      setPhase("submitting");
      const { txHash } = await rpc.sendRawTransaction(payload.chainId, signed);
      setBroadcastedTxHash(txHash);
      onBroadcasted?.({
        chainId: payload.chainId,
        assetAddress: ETH_SENTINEL,
        txHash,
      });

      console.log(
        `%c[unshield-broadcast]%c chain ${payload.chainId} txHash %c${txHash}`,
        "color:#0a7;font-weight:bold",
        "color:inherit",
        "color:#06f;text-decoration:underline",
      );

      // Optimistic IDB writes. Mark the spent input + append the
      // change-to-self note (when present). The exit slot is the
      // user's own public balance — usePublicBalance picks it up
      // from the chain RPC on its own.
      try {
        await patchNoteByLeaf(inputNote.leafCommitment, {
          state: "spent",
          spentTxHash: txHash,
          nullifier: prep.spentNullifier,
        });
        if (prep.changeOutput) {
          await appendNote({
            asset: prep.changeOutput.asset,
            assetDecimals: inputNote.assetDecimals,
            amount: prep.changeOutput.amount,
            owner: prep.changeOutput.owner,
            secret:
              "0x" +
              BigInt(prep.changeOutput.secret).toString(16).padStart(64, "0"),
            networkChainId: payload.chainId,
            deploymentAddress: deployment.pampaloAddress,
            leafCommitment: prep.changeOutput.leafCommitment,
            origin: "transferIn",
            state: "spendable",
            queuedTxHash: txHash,
          });
        }
      } catch (idbErr) {
        console.warn("[unshield] optimistic IDB writes failed", idbErr);
      }

      setPhase("awaiting");
      toast.success(
        `Unshielded ${amountFmt} ${payload.symbol} · ${txHash.slice(0, 10)}…${txHash.slice(-6)}`,
      );
      await new Promise((r) => setTimeout(r, 900));
      setPhase("done");
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("error");
    }
  };

  const isBusy =
    phase === "preparing" ||
    phase === "signing" ||
    phase === "submitting" ||
    phase === "awaiting";
  const closeable = !isBusy;
  const confirmDisabled = !payload || !deployment || isBusy || phase === "done";

  const confirmLabel = (() => {
    switch (phase) {
      case "preparing":
        return "Generating proof…";
      case "signing":
        return "Awaiting passkey…";
      case "submitting":
        return "Submitting unshield transaction…";
      case "awaiting":
        return "Awaiting confirmation…";
      case "done":
        return "Done";
      case "error":
        return "Try again";
      default:
        return payload
          ? `Confirm unshield · ${amountFmt} ${payload.symbol}`
          : "Confirm";
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
            <ShieldOff className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Confirm unshield
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5 pb-5 pt-4 sm:px-6">
        {/* Summary card */}
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
              <div className="text-[11.5px] text-ink-mute">
                Moving from your shielded balance back to your public
                wallet on{" "}
                {deployment ? `chain ${deployment.chainId}` : "this chain"}.
              </div>
            </div>
            <Sun className="size-5 shrink-0 text-[var(--pub)]" aria-hidden />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-[11.5px]">
            <div>
              <div className="text-ink-mute">Pampalo router</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-ink">
                {deployment?.pampaloAddress ?? "…"}
              </div>
            </div>
            <div>
              <div className="text-ink-mute">Recipient</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-ink">
                {addresses.evm}
              </div>
            </div>
          </div>
        </div>

        {/* Status / error line */}
        <StatusLine phase={phase} error={error} />

        {/* Action stack — same shape as ShieldConfirmSheet. */}
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

        {phase === "done" && broadcastedTxHash && (
          <details className="rounded-xl bg-paper-lo px-3.5 py-3 text-[11.5px] text-ink-soft">
            <summary className="cursor-pointer select-none font-semibold text-ink">
              Broadcast details
            </summary>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink">
              <dt className="text-ink-mute">txHash</dt>
              <dd className="truncate">{broadcastedTxHash}</dd>
              <dt className="text-ink-mute">signedTx</dt>
              <dd className="truncate">{signedTx ?? "…"}</dd>
            </dl>
          </details>
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
            <DialogTitle>Confirm unshield</DialogTitle>
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
          <SheetTitle>Confirm unshield</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function StatusLine({
  phase,
  error,
}: {
  phase: Phase;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
        {error}
      </div>
    );
  }
  if (phase === "preparing") {
    return (
      <ProgressLine
        label="Generating proof"
        sub="First run on a fresh tab pays the bb.js WASM warm-up (a few seconds)."
      />
    );
  }
  if (phase === "signing") {
    return (
      <ProgressLine
        label="Awaiting passkey signature"
        sub="Approve the passkey prompt to decrypt your mnemonic and sign locally."
      />
    );
  }
  if (phase === "submitting") {
    return (
      <ProgressLine
        label="Submitting unshield transaction"
        sub="Broadcasting the signed unshield to the network."
      />
    );
  }
  if (phase === "awaiting") {
    return (
      <ProgressLine
        label="Awaiting confirmation"
        sub="Transaction accepted by the node. The asset row will track the on-chain receipt."
      />
    );
  }
  if (phase === "done") {
    return (
      <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
        Unshield broadcast. Your public balance updates as soon as the tx mines.
      </div>
    );
  }
  return null;
}

function ProgressLine({ label, sub }: { label: string; sub?: string }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]"
      aria-live="polite"
    >
      <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold">{label}…</div>
        {sub && <div className="mt-0.5 text-[11.5px] text-ink-mute">{sub}</div>}
      </div>
    </div>
  );
}

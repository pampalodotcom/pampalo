import { useEffect, useMemo, useState } from "react";
import { Loader2, Moon, ShieldCheck } from "lucide-react";
import { useQuery } from "convex/react";
import { VisuallyHidden } from "radix-ui";
import { api } from "../../../../convex/_generated/api";
import { signTransactionWithPasskey } from "@/lib/auth-flow";
import {
  prepareShieldNative,
  type PreparedShieldNativeTx,
} from "@/lib/shield-prep";
import { useRpcClient } from "@/lib/rpc";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AssetMark } from "../AssetMark";

// Slice-6 confirm sheet for the shield flow. Wires:
//   1. Proof gen (lazy-loaded bb.js + deposit circuit)
//   2. ECIES encrypt of the note payload to self envelope key
//   3. Passkey unlock → mnemonic decrypt → tx signing
//
// Stops just before broadcasting — the signed tx hex is `console.log`'d
// instead. Wired this way deliberately while the IDB optimistic-write
// path is still under construction (SHIELD_FLOW.md §7.1 step 9).

// Conservative shield gas: the circuit verifier alone is ~400k, queue
// storage + ERC20.transferFrom (or ETH escrow) adds maybe 80k. 800k
// covers both with headroom; revisit after live observation.
const SHIELD_GAS_LIMIT = 800_000n;

type Phase =
  | "idle"
  | "preparing"
  | "signing"
  | "signed"
  | "error";

export type ShieldConfirmPayload = {
  intent: "shield";
  amount: bigint;
  chainId: number;
  symbol: string;
  decimals: number;
};

type Props = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  payload: ShieldConfirmPayload | null;
  /** Passkey-derived addresses for the user. */
  addresses: {
    evm: string;
    envelope: string;
    poseidon: string;
  };
};

export function ShieldConfirmSheet({
  open,
  onOpenChange,
  payload,
  addresses,
}: Props) {
  const isDesktop = useIsDesktop();
  const rpc = useRpcClient();

  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const gas = useQuery(
    api.prices.gas.latestForChain,
    payload ? { chainId: payload.chainId } : "skip",
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedShieldNativeTx | null>(null);
  const [signedTx, setSignedTx] = useState<string | null>(null);

  // Reset everything when the sheet closes so a re-open starts clean.
  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setError(null);
      setPrepared(null);
      setSignedTx(null);
    }
  }, [open]);

  // Resolve the (chainId → pampaloAddress + cached shield-wait) row
  // for this payload's chain. If absent the chain isn't actually
  // shieldable; we render a friendly error instead of letting prep run.
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

  const onConfirm = async () => {
    if (!payload || !deployment) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    setError(null);

    try {
      setPhase("preparing");
      // (1) Proof + ECIES payload + calldata. Heavy — first run pays
      // the bb.js WASM warmup; subsequent runs in the same tab are fast.
      const prep = await prepareShieldNative({
        amount: payload.amount,
        chainId: payload.chainId,
        pampaloAddress: deployment.pampaloAddress,
        ownerPoseidon: addresses.poseidon,
        envelopePubKey: addresses.envelope,
      });
      setPrepared(prep);

      // (2) Nonce + gas fields.
      const nonceRes = await rpc.getNonce(payload.chainId, addresses.evm);
      const useEip1559 = gas.priorityFeeWei !== undefined;
      const baseGasPriceWei = BigInt(gas.gasPriceWei);
      const maxPriorityFeePerGas =
        useEip1559 && gas.priorityFeeWei !== undefined
          ? BigInt(gas.priorityFeeWei)
          : undefined;
      const maxFeePerGas = useEip1559 ? baseGasPriceWei : undefined;
      const legacyGasPrice = useEip1559 ? undefined : baseGasPriceWei;

      // (3) Passkey unlock → mnemonic decrypt → signTransaction. This
      // is the moment the user sees the WebAuthn ceremony.
      setPhase("signing");
      const signed = await signTransactionWithPasskey({
        chainId: payload.chainId,
        to: prep.to,
        value: BigInt(prep.value),
        data: prep.data,
        nonce: Number(nonceRes.nonce),
        gasLimit: SHIELD_GAS_LIMIT,
        gasPrice: legacyGasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      setSignedTx(signed);
      setPhase("signed");

      // Stopping point per the current build order — broadcast lands
      // in a follow-up alongside the optimistic IDB write. Dump
      // everything to the console so the user can inspect.
      console.log("[shield] prepared", {
        chainId: payload.chainId,
        to: prep.to,
        value: prep.value,
        leafCommitment: prep.leafCommitment,
        secret: prep.secret,
        encryptedPayload: prep.encryptedPayload,
        publicInputs: prep.publicInputs,
        proofBytes: prep.proofBytes,
        signedTx: signed,
        broadcastEndpoint: "(skipped — would call rpc.sendRawTransaction)",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("error");
    }
  };

  const closeable = phase !== "preparing" && phase !== "signing";
  const confirmDisabled =
    !payload ||
    !deployment ||
    phase === "preparing" ||
    phase === "signing" ||
    phase === "signed";

  const confirmLabel = (() => {
    switch (phase) {
      case "preparing":
        return "Generating proof…";
      case "signing":
        return "Awaiting passkey…";
      case "signed":
        return "Signed — see console";
      case "error":
        return "Try again";
      default:
        return payload
          ? `Confirm shield · ${amountFmt} ${payload.symbol}`
          : "Confirm";
    }
  })();

  const body = (
    <div className="flex flex-col">
      <header className="flex items-center justify-between px-5 pt-3 sm:px-6 sm:pt-4">
        <div className="inline-flex items-center gap-2">
          <span
            className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--priv-soft)] text-[var(--priv)]"
            aria-hidden
          >
            <ShieldCheck className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Confirm shield
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
                Moving from public balance into a private note on{" "}
                {deployment ? `chain ${deployment.chainId}` : "this chain"}.
              </div>
            </div>
            <Moon className="size-5 shrink-0 text-[var(--priv)]" aria-hidden />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-[11.5px]">
            <div>
              <div className="text-ink-mute">Pampalo router</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-ink">
                {deployment?.pampaloAddress ?? "…"}
              </div>
            </div>
            <div>
              <div className="text-ink-mute">Wait</div>
              <div className="mt-0.5 font-mono text-[11px] text-ink">
                {deployment
                  ? formatWait(deployment.shieldWaitSeconds)
                  : "…"}{" "}
                · finalise after
              </div>
            </div>
          </div>
        </div>

        {/* Status / error line */}
        <StatusLine phase={phase} error={error} />

        {/* Action stack — Confirm sits on top of Cancel on every viewport,
            so the primary action is always closest to the user's thumb /
            cursor. The button row was originally a row on desktop but
            long ETH amounts blew it out past the dialog width; the
            column layout sidesteps that and keeps Cancel visible. */}
        <div className="flex flex-col gap-2">
          {phase !== "signed" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className={cn(
                "inline-flex h-[56px] sm:h-[48px] w-full items-center justify-center gap-2",
                "rounded-full px-5 text-[14px] font-bold text-white",
                "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
                "shadow-sm transition-opacity",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {(phase === "preparing" || phase === "signing") && (
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
            {phase === "signed" ? "Close" : "Cancel"}
          </button>
        </div>

        {phase === "signed" && prepared && signedTx && (
          <details className="rounded-xl bg-paper-lo px-3.5 py-3 text-[11.5px] text-ink-soft">
            <summary className="cursor-pointer select-none font-semibold text-ink">
              Prepared TX details (signed, not broadcast)
            </summary>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink">
              <dt className="text-ink-mute">leafCommitment</dt>
              <dd className="truncate">{prepared.leafCommitment}</dd>
              <dt className="text-ink-mute">value (wei)</dt>
              <dd className="truncate">{prepared.value}</dd>
              <dt className="text-ink-mute">signedTx</dt>
              <dd className="truncate">{signedTx}</dd>
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
            <DialogTitle>Confirm shield</DialogTitle>
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
          <SheetTitle>Confirm shield</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function formatWait(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.round(seconds / 3600);
    return `${h}h`;
  }
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m}m`;
  }
  return `${seconds}s`;
}

function StatusLine({
  phase,
  error,
}: {
  phase: Phase;
  error: string | null;
}) {
  if (phase === "error" && error) {
    return (
      <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
        {error}
      </div>
    );
  }
  if (phase === "preparing") {
    return (
      <div className="text-[12.5px] text-ink-mute">
        Generating the deposit proof and encrypting the note to your own
        envelope key. First run pulls down the prover bundle (~few MB), so
        this can take a few seconds.
      </div>
    );
  }
  if (phase === "signing") {
    return (
      <div className="text-[12.5px] text-ink-mute">
        Approve the passkey prompt to decrypt your mnemonic and sign the
        transaction. The signed bytes never leave this tab.
      </div>
    );
  }
  if (phase === "signed") {
    return (
      <div className="rounded-xl border border-[var(--priv-soft-2)] bg-[var(--priv-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--priv)]">
        Signed transaction is ready. Check the browser console for the
        prepared payload — broadcasting lands in the next slice.
      </div>
    );
  }
  return (
    <div className="text-[12.5px] text-ink-mute">
      Tap Confirm to generate the proof and sign the transaction. We'll
      stop just before broadcasting so you can inspect what's about to be
      sent.
    </div>
  );
}

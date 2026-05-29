import { useEffect, useMemo, useState } from "react";
import { Loader2, Moon, ShieldCheck } from "lucide-react";
import { useQuery } from "convex/react";
import { VisuallyHidden } from "radix-ui";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { ETH_SENTINEL } from "@/lib/eth";
import { appendNote } from "@/lib/idb-notes";
import {
  buildErc20Approve,
  prepareShieldErc20,
  prepareShieldNative,
  type PreparedShieldErc20Tx,
  type PreparedShieldNativeTx,
} from "@/lib/shield-prep";
import { withUnlockedWallet } from "@/lib/auth-flow";
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

// UltraHonk verify() on the deposit circuit is gas-monstrous —
// 6–7M is realistic on Base Sepolia. First tx with 800k consumed
// 98.7% before reverting (almost certainly OOG masquerading as
// "execution reverted"). Setting 7M as the starting budget; tune
// downward once we have a confirmed shield receipt to measure
// against. Base Sepolia's block gas limit is well above this, so the
// only cost is the gas fee.
const SHIELD_GAS_LIMIT = 7_000_000n;
// ERC-20 approve costs ~46k for a fresh slot, ~30k for a re-approve.
// 120k leaves comfortable headroom across all ERC-20 implementations
// we'd plausibly see.
const APPROVE_GAS_LIMIT = 120_000n;

// Local alias for readability at the IDB-write call site below.
// ETH_SENTINEL lives in src/lib/eth.ts as the single source of truth.
const ETH_ADDRESS = ETH_SENTINEL;

type Phase =
  | "idle"
  | "preparing"
  | "signing"
  | "approving"
  | "submitting"
  | "awaiting"
  | "done"
  | "error";

export type ShieldConfirmPayload = {
  intent: "shield";
  amount: bigint;
  chainId: number;
  symbol: string;
  decimals: number;
  /** Lowercased asset address. `ETH_SENTINEL` for native ETH; an
   *  ERC-20 contract address otherwise. Drives the prepareShield* fork
   *  + the approve preamble. */
  assetAddress: string;
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
  /** Fired after the raw tx is accepted by Alchemy. Caller registers
   *  the (chainId, asset) as "confirming on-chain" so the asset row
   *  locks its slider + action buttons until the receipt mines. */
  onBroadcasted?: (info: {
    chainId: number;
    assetAddress: string;
    txHash: string;
  }) => void;
};

export function ShieldConfirmSheet({
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

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<
    PreparedShieldNativeTx | PreparedShieldErc20Tx | null
  >(null);
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

    // Defensive: the route is supposed to inject the asset address from
    // the catalog before opening this sheet. If it didn't, we'd silently
    // misroute through prepareShieldNative and shield as ETH at the
    // wrong decimals — exactly the bug that ate 2,478,900 wei trying to
    // shield USDC. Fail loudly instead.
    if (
      !payload.assetAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(payload.assetAddress)
    ) {
      setError(
        `Shield was opened without a resolved ${payload.symbol} address. ` +
          "Close the sheet, reload, and try again.",
      );
      setPhase("error");
      return;
    }
    const isNative =
      payload.assetAddress.toLowerCase() === ETH_ADDRESS.toLowerCase();
    if (!isNative && payload.symbol.toUpperCase() === "ETH") {
      setError(
        "ETH/asset address mismatch detected. Refusing to shield to avoid a " +
          "wrong-decimals broadcast.",
      );
      setPhase("error");
      return;
    }

    try {
      setPhase("preparing");
      // (1) Proof + ECIES payload + calldata. Heavy — first run pays
      // the bb.js WASM warmup; subsequent runs in the same tab are fast.
      const prep = isNative
        ? await prepareShieldNative({
            amount: payload.amount,
            chainId: payload.chainId,
            pampaloAddress: deployment.pampaloAddress,
            ownerPoseidon: addresses.poseidon,
            envelopePubKey: addresses.envelope,
          })
        : await prepareShieldErc20({
            tokenAddress: payload.assetAddress,
            amount: payload.amount,
            chainId: payload.chainId,
            pampaloAddress: deployment.pampaloAddress,
            ownerPoseidon: addresses.poseidon,
            envelopePubKey: addresses.envelope,
          });
      setPrepared(prep);

      // (2) Gas fields + starting nonce. For ERC-20 we'll consume two
      // sequential nonces — approve(N) then shield(N+1). EVM guarantees
      // they execute in nonce order, so the shield can never observe a
      // stale allowance.
      const nonceRes = await rpc.getNonce(payload.chainId, addresses.evm);
      const startNonce = Number(nonceRes.nonce);
      const useEip1559 = gas.priorityFeeWei !== undefined;
      const baseGasPriceWei = BigInt(gas.gasPriceWei);
      const maxPriorityFeePerGas =
        useEip1559 && gas.priorityFeeWei !== undefined
          ? BigInt(gas.priorityFeeWei)
          : undefined;
      const maxFeePerGas = useEip1559 ? baseGasPriceWei : undefined;
      const legacyGasPrice = useEip1559 ? undefined : baseGasPriceWei;
      const fees = useEip1559
        ? {
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasPrice: undefined as bigint | undefined,
            type: 2 as number | undefined,
          }
        : {
            maxFeePerGas: undefined as bigint | undefined,
            maxPriorityFeePerGas: undefined as bigint | undefined,
            gasPrice: legacyGasPrice,
            type: undefined as number | undefined,
          };

      // (3) Sign in one PRF window. For ERC-20 this is { approve, shield };
      // for ETH it's just { shield }. `withUnlockedWallet` runs the PRF
      // ceremony once and yields the unlocked Wallet to this closure.
      setPhase("signing");
      const signed = await withUnlockedWallet(async (wallet) => {
        const buildAndSign = (
          to: string,
          data: string,
          value: bigint,
          nonce: number,
          gasLimit: bigint,
        ) =>
          wallet.signTransaction({
            chainId: payload.chainId,
            to,
            data,
            value,
            nonce,
            gasLimit,
            ...fees,
          });

        if (isNative) {
          const shieldSigned = await buildAndSign(
            prep.to,
            prep.data,
            BigInt(prep.value),
            startNonce,
            SHIELD_GAS_LIMIT,
          );
          return { shield: shieldSigned, approve: null as string | null };
        }
        // ERC-20: approve(spender = pampalo router, amount) at nonce N,
        // then shield(asset, amount, ...) at nonce N+1.
        const approveTx = buildErc20Approve(
          payload.assetAddress,
          deployment.pampaloAddress,
          payload.amount,
        );
        const approveSigned = await buildAndSign(
          approveTx.to,
          approveTx.data,
          BigInt(approveTx.value),
          startNonce,
          APPROVE_GAS_LIMIT,
        );
        const shieldSigned = await buildAndSign(
          prep.to,
          prep.data,
          BigInt(prep.value),
          startNonce + 1,
          SHIELD_GAS_LIMIT,
        );
        return { approve: approveSigned, shield: shieldSigned };
      });
      setSignedTx(signed.shield);

      // (4) Broadcast. ERC-20 path sends approve first, then shield.
      // We don't wait for approve to mine — nonce ordering ensures the
      // shield can't execute before the approve regardless of when
      // each lands. If approve reverts, shield reverts too (no
      // double-spend hazard).
      if (signed.approve) {
        setPhase("approving");
        await rpc.sendRawTransaction(payload.chainId, signed.approve);
      }
      setPhase("submitting");
      const { txHash } = await rpc.sendRawTransaction(
        payload.chainId,
        signed.shield,
      );
      onBroadcasted?.({
        chainId: payload.chainId,
        assetAddress: payload.assetAddress,
        txHash,
      });

      // Optimistic IDB write — same as native shield.
      try {
        await appendNote({
          asset: payload.assetAddress,
          assetDecimals: payload.decimals,
          amount: payload.amount.toString(),
          owner: addresses.poseidon,
          secret: "0x" + BigInt(prep.secret).toString(16).padStart(64, "0"),
          networkChainId: payload.chainId,
          deploymentAddress: deployment.pampaloAddress,
          leafCommitment: prep.leafCommitment,
          origin: "shield",
          state: "queued",
          unlockTime:
            Math.floor(Date.now() / 1000) + deployment.shieldWaitSeconds,
          queuedTxHash: txHash,
        });
      } catch (idbErr) {
        console.warn("[shield] optimistic IDB write failed", idbErr);
      }

      // Brief "awaiting confirmation" state so the user sees the final
      // step land before the sheet closes and hands off to the asset
      // row's "Confirming on-chain…" pill (driven by wallet.tsx's
      // receipt poll). Without this beat the broadcast → close
      // transition looks instantaneous and the journey is lost.
      setPhase("awaiting");
      toast.success(
        `Shield broadcast · ${txHash.slice(0, 10)}…${txHash.slice(-6)}`,
      );
      console.log("[shield] broadcast", {
        chainId: payload.chainId,
        txHash,
        leafCommitment: prep.leafCommitment,
      });
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
    phase === "approving" ||
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
      case "approving":
        return payload
          ? `Approving Pampalo for ${amountFmt} ${payload.symbol}…`
          : "Approving…";
      case "submitting":
        return "Submitting shield transaction…";
      case "awaiting":
        return "Awaiting confirmation…";
      case "done":
        return "Done";
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
        <StatusLine
          phase={phase}
          error={error}
          symbol={payload?.symbol}
          amountFmt={amountFmt}
        />

        {/* Action stack — Confirm sits on top of Cancel on every viewport,
            so the primary action is always closest to the user's thumb /
            cursor. The button row was originally a row on desktop but
            long ETH amounts blew it out past the dialog width; the
            column layout sidesteps that and keeps Cancel visible. */}
        <div className="flex flex-col gap-2">
          {phase !== "done" && (
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

        {phase === "done" && prepared && signedTx && (
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
  symbol,
  amountFmt,
}: {
  phase: Phase;
  error: string | null;
  symbol?: string;
  amountFmt?: string;
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
      <ProgressLine
        label="Generating proof"
        sub="First run pulls down the prover bundle (~few MB), so this can take a few seconds."
      />
    );
  }
  if (phase === "signing") {
    return (
      <ProgressLine
        label="Awaiting passkey signature"
        sub="Approve the passkey prompt to decrypt your mnemonic and sign locally — the signed bytes never leave this tab."
      />
    );
  }
  if (phase === "approving") {
    return (
      <ProgressLine
        label={
          symbol && amountFmt
            ? `Approving Pampalo to move ${amountFmt} ${symbol}`
            : "Approving Pampalo to move tokens"
        }
        sub="Sending the ERC-20 allowance transaction. The shield broadcast follows immediately after."
      />
    );
  }
  if (phase === "submitting") {
    return (
      <ProgressLine
        label="Submitting shield transaction"
        sub="Broadcasting the signed shield to the network."
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
      <div className="rounded-xl border border-[var(--priv-soft-2)] bg-[var(--priv-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--priv)]">
        Shield broadcast. Track confirmation from the asset row.
      </div>
    );
  }
  return (
    <div className="text-[12.5px] text-ink-mute">
      Tap Confirm to generate the proof and sign the transaction. We'll
      broadcast it to the network once you approve the passkey prompt.
    </div>
  );
}

function ProgressLine({ label, sub }: { label: string; sub?: string }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border border-[var(--priv-soft-2)] bg-[var(--priv-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--priv)]"
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

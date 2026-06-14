import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { formatUnits, parseUnits } from "ethers";
import { ArrowDownUp, CheckCircle2, Loader2, Moon } from "lucide-react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { withUnlockedWallet } from "@/lib/auth-flow";
import { deriveEnvelopePrivKeys } from "@/lib/derive-addresses";
import { syncShieldNotesWithKeys } from "@/lib/sync-shield-notes";
import {
  appendNote,
  getNotesSnapshot,
  isNoteOnActiveDeployment,
  patchNoteByLeaf,
  subscribeNotes,
  type StoredNote,
} from "@/lib/idb-notes";
import { useMerkleTree } from "@/lib/use-merkle-tree";
import { useRpcClient } from "@/lib/rpc";
import {
  encodeV3Path,
  prepareSwap,
  warmSwap,
  type SwapInputNote,
} from "@/lib/swap-prep";
import { normalizeBroadcastError } from "@/lib/broadcast-error";
import { cn } from "@/lib/utils";
import { AssetMark } from "./AssetMark";

// ADR 0023/0024 — the private-swap surface inside SwapModal's "Private" tab.
// v1 demo scope: single-hop WETH↔USDC on Base mainnet (the only chain with
// real v3 liquidity), single input note, self-broadcast. The output asset-B
// note + same-asset change note are minted to self.

const SWAP_CHAIN_ID = 8453;
const V3_FEE = 500; // 0.05% WETH/USDC pool
const SLIPPAGE_BPS = 50n; // 0.5% floor → target output T
const SWAP_GAS_LIMIT = 8_000_000n;

const USDC = {
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
  decimals: 6,
};
const WETH = {
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  decimals: 18,
};

type Phase =
  | "idle"
  | "quoting"
  | "preparing"
  | "signing"
  | "submitting"
  | "done"
  | "error";

export function PrivateSwapPanel({
  evmAddress,
  envelope,
  poseidon,
  onClose,
}: {
  evmAddress: string;
  envelope: string;
  poseidon: string;
  onClose: () => void;
}) {
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const merkle = useMerkleTree(SWAP_CHAIN_ID, true);
  const gas = useQuery(api.prices.gas.latestForChain, {
    chainId: SWAP_CHAIN_ID,
  });
  const rpc = useRpcClient();
  const getQuote = useAction(api.swap.actions.getQuote);
  const prices = useQuery(api.prices.feeds.listLatest, {});

  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () =>
    getNotesSnapshot(),
  );

  // Direction: true = USDC → WETH, false = WETH → USDC.
  const [usdcToWeth, setUsdcToWeth] = useState(true);
  const [rawAmount, setRawAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [quotedOut, setQuotedOut] = useState<bigint | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [viewUnit, setViewUnit] = useState<"token" | "usd">("token");
  // Envelope keys captured during the swap's single passkey unlock so the
  // post-tx auto-sync can poll without re-prompting. Cleared on close/unmount.
  const keysRef = useRef<{ keys: string[]; address: string } | null>(null);
  const watchLeafRef = useRef<string | null>(null);

  const tokenIn = usdcToWeth ? USDC : WETH;
  const tokenOut = usdcToWeth ? WETH : USDC;

  // Present WETH as "ETH" (icon + label) for now — presentation only; the swap
  // is still WETH on-chain, until the ETH↔WETH wrap ships (ADR 0024).
  const disp = (s: string) => (s === "WETH" ? "ETH" : s);

  // USD/token view toggle — USDC ≈ $1; ETH/WETH track the eth/usd feed.
  const ethUsd = useMemo(() => {
    const feed = prices?.find((p) => p.shortId === "eth/usd");
    return feed ? Number(feed.answer) / 10 ** feed.feedDecimals : null;
  }, [prices]);
  const usdPerToken = (t: { symbol: string }): number | null =>
    t.symbol === "USDC" ? 1 : ethUsd;

  useEffect(() => {
    void warmSwap();
  }, []);

  const deployment = useMemo(
    () => deployments?.find((d) => d.chainId === SWAP_CHAIN_ID) ?? null,
    [deployments],
  );

  // Spendable private notes for the input asset on the active deployment.
  const inputNotes = useMemo<StoredNote[]>(() => {
    return notes.filter(
      (n) =>
        n.state === "spendable" &&
        n.networkChainId === SWAP_CHAIN_ID &&
        isNoteOnActiveDeployment(n, deployments) &&
        n.asset === tokenIn.address &&
        n.leafIndex !== undefined,
    );
  }, [notes, deployments, tokenIn.address]);

  const availableWei = useMemo(
    () => inputNotes.reduce((sum, n) => sum + BigInt(n.amount), 0n),
    [inputNotes],
  );

  const amountWei = useMemo(() => {
    try {
      if (!rawAmount || Number(rawAmount) <= 0) return null;
      if (viewUnit === "usd") {
        const px = tokenIn.symbol === "USDC" ? 1 : ethUsd;
        if (!px) return null;
        const tokenAmt = Number(rawAmount) / px;
        return parseUnits(tokenAmt.toFixed(tokenIn.decimals), tokenIn.decimals);
      }
      return parseUnits(rawAmount, tokenIn.decimals);
    } catch {
      return null;
    }
  }, [rawAmount, tokenIn.decimals, tokenIn.symbol, viewUnit, ethUsd]);

  // Debounced quote → expected output → target floor T.
  useEffect(() => {
    if (!amountWei) {
      setQuotedOut(null);
      return;
    }
    let cancelled = false;
    setPhase("quoting");
    const t = setTimeout(() => {
      void getQuote({
        chainId: SWAP_CHAIN_ID,
        version: "v3",
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        kind: "exactIn",
        amount: amountWei.toString(),
      })
        .then((q: { amountOut?: string | null }) => {
          if (cancelled) return;
          setQuotedOut(q.amountOut ? BigInt(q.amountOut) : null);
          setPhase("idle");
        })
        .catch((e) => {
          if (cancelled) return;
          console.warn("[private-swap] quote failed", e);
          setQuotedOut(null);
          setPhase("idle");
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [amountWei, tokenIn.address, tokenOut.address, getQuote]);

  // T = expected out × (1 - slippage). Doubles as the on-chain floor (ADR 0020).
  const targetOut = useMemo(
    () =>
      quotedOut === null
        ? null
        : (quotedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n,
    [quotedOut],
  );

  // Post-tx auto-sync: once submitted, poll-sync using the captured keys (no
  // passkey re-prompt) until the swap's output note is decrypted with a
  // leafIndex — then mark confirmed + stop the pulse. Bounded (~90s) so we
  // don't hold the keys or poll forever.
  useEffect(() => {
    if (phase !== "done" || confirmed) return;
    const k = keysRef.current;
    if (!k) {
      setConfirmed(true);
      return;
    }
    // Mutable holder (not a bare `let`) so eslint's no-unnecessary-condition
    // doesn't treat the cleanup-mutated flag as constant after the await.
    const run = { cancelled: false };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        await syncShieldNotesWithKeys(k.keys, k.address);
      } catch (e) {
        console.warn("[private-swap] post-tx sync failed", e);
      }
      if (run.cancelled) return;
      const leaf = watchLeafRef.current;
      const synced =
        leaf !== null &&
        getNotesSnapshot().some(
          (n) =>
            n.leafCommitment.toLowerCase() === leaf &&
            n.leafIndex !== undefined,
        );
      if (synced || tries >= 30) {
        setConfirmed(true);
        keysRef.current = null;
        return;
      }
      timer = setTimeout(() => void tick(), 3000);
    };
    timer = setTimeout(() => void tick(), 1500);
    return () => {
      run.cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, confirmed]);

  // Drop the captured keys when the panel unmounts.
  useEffect(() => {
    return () => {
      keysRef.current = null;
    };
  }, []);

  const flip = () => {
    setUsdcToWeth((v) => !v);
    setRawAmount("");
    setQuotedOut(null);
    setError(null);
  };

  const insufficient = amountWei !== null && amountWei > availableWei;
  // v1: a single note must cover the full input (multi-note join is future).
  const coveringNote = amountWei
    ? inputNotes.find((n) => BigInt(n.amount) >= amountWei)
    : undefined;

  const canSwap =
    !!deployment &&
    !!merkle.tree &&
    !!amountWei &&
    !insufficient &&
    !!coveringNote &&
    targetOut !== null &&
    targetOut > 0n &&
    phase !== "preparing" &&
    phase !== "signing" &&
    phase !== "submitting";

  const onConfirm = async () => {
    if (
      !deployment ||
      !merkle.tree ||
      !amountWei ||
      !coveringNote ||
      targetOut === null ||
      !gas?.gasPriceWei
    ) {
      return;
    }
    setError(null);
    try {
      const route = encodeV3Path(
        [tokenIn.address, tokenOut.address],
        [V3_FEE],
      );
      const inputNote: SwapInputNote = {
        asset: coveringNote.asset,
        amount: BigInt(coveringNote.amount),
        secret: coveringNote.secret,
        owner: coveringNote.owner,
        leafIndex: coveringNote.leafIndex!,
      };

      setPhase("signing");
      const { prep, signed } = await withUnlockedWallet(async (wallet) => {
        setPhase("preparing");
        // Capture envelope keys from this single unlock so the post-tx sync
        // can poll without re-prompting the passkey.
        keysRef.current = wallet.mnemonic?.phrase
          ? {
              keys: deriveEnvelopePrivKeys(wallet.mnemonic.phrase),
              address: evmAddress,
            }
          : null;
        const built = await prepareSwap({
          chainId: SWAP_CHAIN_ID,
          pampaloAddress: deployment.pampaloAddress,
          inputNotes: [inputNote],
          inputAmount: amountWei,
          outputAsset: tokenOut.address,
          targetOutput: targetOut,
          route,
          selfPoseidon: poseidon,
          selfEnvelopePubKey: envelope,
          walletPrivateKey: wallet.privateKey,
          tree: merkle.tree!,
        });
        const nonce = Number(
          (await rpc.getNonce(SWAP_CHAIN_ID, evmAddress)).nonce,
        );
        const useEip1559 = gas.priorityFeeWei !== undefined;
        const baseGasPriceWei = BigInt(gas.gasPriceWei);
        const signedTx = await wallet.signTransaction({
          chainId: SWAP_CHAIN_ID,
          to: built.to,
          value: 0n,
          data: built.data,
          nonce,
          gasLimit: SWAP_GAS_LIMIT,
          gasPrice: useEip1559 ? undefined : baseGasPriceWei,
          maxFeePerGas: useEip1559 ? baseGasPriceWei : undefined,
          maxPriorityFeePerGas:
            useEip1559 && gas.priorityFeeWei !== undefined
              ? BigInt(gas.priorityFeeWei)
              : undefined,
          type: useEip1559 ? 2 : undefined,
        });
        return { prep: built, signed: signedTx };
      });

      setPhase("submitting");
      const { txHash } = await rpc.sendRawTransaction(SWAP_CHAIN_ID, signed);

      // Optimistic IDB: mark the spent input, add the asset-B output note +
      // any same-asset change note (both owned by self → spendable).
      try {
        await patchNoteByLeaf(coveringNote.leafCommitment, {
          state: "spent",
          spentTxHash: txHash,
          nullifier: prep.spentNullifiers[0],
        });
        for (const minted of [prep.outputNote, prep.changeNote]) {
          if (!minted) continue;
          await appendNote({
            asset: minted.asset.toLowerCase(),
            assetDecimals:
              minted.asset.toLowerCase() === tokenOut.address
                ? tokenOut.decimals
                : tokenIn.decimals,
            amount: minted.amount,
            owner: minted.owner,
            secret:
              "0x" + BigInt(minted.secret).toString(16).padStart(64, "0"),
            networkChainId: SWAP_CHAIN_ID,
            deploymentAddress: deployment.pampaloAddress,
            leafCommitment: minted.leafCommitment,
            origin: "transferIn",
            state: "spendable",
            queuedTxHash: txHash,
          });
        }
      } catch (idbErr) {
        console.warn("[private-swap] optimistic IDB write failed", idbErr);
      }

      toast.success(
        `Swapped ${disp(tokenIn.symbol)} → ${disp(tokenOut.symbol)} privately`,
      );
      watchLeafRef.current = prep.outputNote.leafCommitment.toLowerCase();
      setPhase("done");
      // Stays open with a pulsating logo; the post-tx auto-sync effect (below)
      // polls until the output note is decrypted with a leafIndex.
    } catch (e) {
      const n = normalizeBroadcastError(e);
      setError(n.friendly);
      setPhase("error");
    }
  };

  const busy =
    phase === "preparing" || phase === "signing" || phase === "submitting";

  const outDisplay =
    quotedOut !== null ? formatUnits(quotedOut, tokenOut.decimals) : "—";
  const minOutDisplay =
    targetOut !== null ? formatUnits(targetOut, tokenOut.decimals) : "—";

  const confirmLabel = (() => {
    switch (phase) {
      case "preparing":
        return "Generating proof…";
      case "signing":
        return "Awaiting passkey…";
      case "submitting":
        return "Submitting swap…";
      case "done":
        return "Done";
      default:
        return `Swap ${disp(tokenIn.symbol)} → ${disp(tokenOut.symbol)}`;
    }
  })();

  // ── USD/token view conversions ──────────────────────────────────────────
  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });
  const inPx = usdPerToken(tokenIn);
  const outPx = usdPerToken(tokenOut);
  const payTokenAmt = amountWei
    ? Number(formatUnits(amountWei, tokenIn.decimals))
    : 0;
  const payUsd = inPx !== null ? payTokenAmt * inPx : null;
  const recvTokenAmt =
    quotedOut !== null
      ? Number(formatUnits(quotedOut, tokenOut.decimals))
      : null;
  const recvUsd =
    recvTokenAmt !== null && outPx !== null ? recvTokenAmt * outPx : null;
  const inUnitLabel = viewUnit === "usd" ? "USD" : disp(tokenIn.symbol);
  const outUnitLabel = viewUnit === "usd" ? "USD" : disp(tokenOut.symbol);

  // ── Sticky done state — pulsating logo while the post-tx sync runs ───────
  if (phase === "done") {
    return (
      <div className="flex flex-col items-center gap-4 px-2 pb-1 pt-2 text-center">
        <div className="relative inline-flex size-16 items-center justify-center">
          {!confirmed && (
            <span
              className="absolute inset-0 animate-ping rounded-full bg-[var(--priv-soft-2)] opacity-60"
              aria-hidden
            />
          )}
          <span
            className={cn(
              "absolute inset-0 rounded-full bg-[var(--priv-soft)]",
              !confirmed && "animate-pulse",
            )}
            aria-hidden
          />
          {confirmed ? (
            <CheckCircle2
              className="relative size-10 text-[var(--priv)]"
              aria-hidden
            />
          ) : (
            <Moon className="relative size-8 text-[var(--priv)]" aria-hidden />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="font-serif text-[20px] font-bold text-ink">
            {confirmed ? "Swapped privately!" : "Confirming swap…"}
          </h3>
          <p className="max-w-[340px] text-[13px] text-ink-mute">
            {confirmed
              ? "Your new private balance is ready."
              : "Submitted — syncing your private notes as they’re decrypted. You can keep this open."}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "mt-2 inline-flex h-[44px] w-full items-center justify-center rounded-full",
            confirmed
              ? "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)] text-[14px] font-bold text-white shadow-sm"
              : "border border-line bg-transparent text-[13.5px] font-semibold text-ink hover:bg-paper-lo",
          )}
        >
          {confirmed ? "Done" : "Close"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 pt-1">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setViewUnit((u) => (u === "token" ? "usd" : "token"))}
          className="rounded-full border border-line bg-paper-lo px-2.5 py-1 text-[11.5px] font-semibold text-ink-mute transition-colors hover:bg-card"
        >
          View in {viewUnit === "token" ? "USD" : "tokens"}
        </button>
      </div>

      {/* From */}
      <div className="rounded-2xl border border-line bg-paper-lo px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-ink-mute">You pay (private)</span>
          <span className="text-[11.5px] text-ink-mute">
            Available:{" "}
            {formatUnits(availableWei, tokenIn.decimals)} {disp(tokenIn.symbol)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <AssetMark symbol={disp(tokenIn.symbol)} size={28} />
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={rawAmount}
            onChange={(e) => setRawAmount(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-[18px] font-semibold text-ink outline-none"
          />
          <span className="font-semibold text-ink">{inUnitLabel}</span>
        </div>
        {amountWei !== null && (
          <p className="mt-1 text-[11.5px] text-ink-mute">
            {viewUnit === "usd"
              ? `≈ ${payTokenAmt} ${disp(tokenIn.symbol)}`
              : payUsd !== null
                ? `≈ ${fmtUsd(payUsd)}`
                : ""}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={flip}
        className="mx-auto -my-1 inline-flex size-8 items-center justify-center rounded-full border border-line bg-card text-ink-mute transition-colors hover:bg-paper-lo"
        aria-label="Flip direction"
      >
        <ArrowDownUp className="size-4" />
      </button>

      {/* To */}
      <div className="rounded-2xl border border-line bg-paper-lo px-4 py-3">
        <span className="text-[12px] text-ink-mute">You receive (private)</span>
        <div className="mt-2 flex items-center gap-3">
          <AssetMark symbol={disp(tokenOut.symbol)} size={28} />
          <span className="min-w-0 flex-1 truncate font-mono text-[18px] font-semibold text-ink">
            {phase === "quoting"
              ? "…"
              : viewUnit === "usd"
                ? recvUsd !== null
                  ? fmtUsd(recvUsd)
                  : "—"
                : outDisplay}
          </span>
          <span className="font-semibold text-ink">{outUnitLabel}</span>
        </div>
        {quotedOut !== null && (
          <p className="mt-1 text-[11.5px] text-ink-mute">
            {viewUnit === "usd"
              ? `≈ ${outDisplay} ${disp(tokenOut.symbol)}`
              : recvUsd !== null
                ? `≈ ${fmtUsd(recvUsd)}`
                : ""}
          </p>
        )}
        {targetOut !== null && (
          <p className="mt-1 text-[11.5px] text-ink-mute">
            Minimum received {minOutDisplay} {disp(tokenOut.symbol)} (0.5% floor) ·
            surplus is forfeited (ADR 0020)
          </p>
        )}
      </div>

      {insufficient && (
        <p className="text-[12.5px] text-[var(--pub)]">
          Not enough private {disp(tokenIn.symbol)}.
        </p>
      )}
      {amountWei && !insufficient && !coveringNote && (
        <p className="text-[12.5px] text-[var(--pub)]">
          No single note covers this amount yet (multi-note swaps coming soon).
        </p>
      )}
      {error && (
        <div className="rounded-xl border border-[var(--priv-soft-2)] bg-[var(--priv-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--priv)]">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={!canSwap}
        className={cn(
          "inline-flex h-[52px] w-full items-center justify-center gap-2",
          "rounded-full px-5 text-[14px] font-bold text-white",
          "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
          "shadow-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {busy && <Loader2 className="size-4 shrink-0 animate-spin" />}
        <span className="truncate">{confirmLabel}</span>
      </button>
    </div>
  );
}

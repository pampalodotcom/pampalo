import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatEther, parseEther } from "ethers";
import { useQuery } from "convex/react";
import {
  CheckCircle2,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { signTransactionWithPasskey, withUnlockedWallet } from "@/lib/auth-flow";
import { ETH_SENTINEL } from "@/lib/eth";
import { txUrl } from "@/lib/explorer";
import {
  appendNote,
  getNotesSnapshot,
  isNotesHydrated,
  patchNoteByLeaf,
  subscribeNotes,
  type StoredNote,
} from "@/lib/idb-notes";
import { useRpcClient } from "@/lib/rpc";
import { prepareTransfer } from "@/lib/transfer-prep";
import { useMerkleTree } from "@/lib/use-merkle-tree";
import { cn } from "@/lib/utils";
import { AssetMark } from "@/components/pampalo/AssetMark";
import { NetworkLogo } from "@/components/pampalo/deposit/NetworkLogo";
import { SunIcon, MoonIcon } from "@/components/pampalo/SunMoonIcons";
import type { SendInputUnit, SendMode, SendRecipient } from "./SendSheet";

// Step 3 — review summary + broadcast.
//
// Demo path:
//   - PRIVATE: build proof via prepareTransfer (single input note,
//     1..2 outputs), self-broadcast via signTransactionWithPasskey,
//     write optimistic IDB rows. Receiver discovery is a separate
//     Sync extension (TRANSFERS.md §9.5).
//   - PUBLIC: send native ETH via signTransactionWithPasskey directly.
//     No relayer; nothing fancy. Existing SendModal is still the
//     polished public path — this is a minimal version for the unified
//     sheet.
//
// Celebratory state pattern mirrors `ActionConfirmSheet.tsx`:
// preparing → signing → broadcasting → submitted (loading panel) →
// confirmed (success panel). Receipt polling reuses
// rpc.getTransactionStatus.

type Phase =
  | "idle"
  | "preparing"
  | "signing"
  | "broadcasting"
  | "submitted"
  | "confirmed"
  | "error";

const POLL_INTERVAL_MS = 2_500;
const CONFIRMATIONS_NEEDED = 1;
// First on-chain transfer at 2M reverted at 1,971,304 gas used (98.57%
// — classic OOG). Verifier + per-output merkle _insert (~605k each via
// the huff Poseidon hasher's 11 staticcalls) + nullifier writes adds
// up fast and the variance leaves no safe margin near the limit. 8M
// gives uncomfortable headroom now; once we measure actual costs across
// the 1/2 and 1/3 output paths we can tighten.
const TRANSFER_GAS_LIMIT = 8_000_000n;
const PUBLIC_SEND_GAS_LIMIT = 21_000n;

export function SendReviewStep({
  mode,
  chainId,
  amount,
  inputUnit,
  recipient,
  evmAddress,
  selfPoseidon,
  selfEnvelopePubKey,
  onBack,
  onClose,
}: {
  mode: SendMode;
  chainId: number | null;
  amount: string;
  inputUnit: SendInputUnit;
  recipient: SendRecipient | null;
  evmAddress: string;
  selfPoseidon: string;
  selfEnvelopePubKey: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const rpc = useRpcClient();
  const accent = mode === "private" ? "priv" : "pub";

  // Private-mode-only resources. Both Convex queries skip until we
  // know the chain.
  const merkle = useMerkleTree(chainId, mode === "private");
  const deployments = useQuery(
    api.shieldQueue.store.enabledDeployments,
    {},
  );
  const gas = useQuery(
    api.prices.gas.latestForChain,
    chainId !== null ? { chainId } : "skip",
  );
  const prices = useQuery(api.prices.feeds.listLatest, {});
  const ethUsdPrice = useMemo<number | null>(() => {
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  }, [prices]);

  const notes = useSyncExternalStore(
    subscribeNotes,
    getNotesSnapshot,
    () => getNotesSnapshot(),
  );

  const amountWei = useMemo<bigint | null>(() => {
    if (!amount) return null;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    try {
      if (inputUnit === "token") return parseEther(amount);
      if (!ethUsdPrice || ethUsdPrice <= 0) return null;
      // USD → ETH: divide USD by price-per-ETH. Truncate to 18 dp
      // before parseEther since float division may overshoot.
      const ethAmt = (n / ethUsdPrice).toFixed(18);
      return parseEther(ethAmt);
    } catch {
      return null;
    }
  }, [amount, inputUnit, ethUsdPrice]);

  // Pick the first spendable IDB note that covers the amount. Single-
  // input only for the demo; multi-input join is a follow-up.
  const inputNote = useMemo<StoredNote | null>(() => {
    if (mode !== "private" || chainId === null) return null;
    if (!isNotesHydrated()) return null;
    if (amountWei === null) return null;
    return (
      notes.find(
        (n) =>
          n.state === "spendable" &&
          n.networkChainId === chainId &&
          n.asset === ETH_SENTINEL &&
          n.leafIndex !== undefined &&
          BigInt(n.amount) >= amountWei,
      ) ?? null
    );
  }, [mode, chainId, amountWei, notes]);

  const deployment = useMemo(() => {
    if (chainId === null || !deployments) return null;
    return deployments.find((d) => d.chainId === chainId) ?? null;
  }, [deployments, chainId]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Receipt polling — same shape as ActionConfirmSheet.
  useEffect(() => {
    if (phase !== "submitted" || !txHash || chainId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await rpc.getTransactionStatus(chainId, txHash);
        if (cancelled) return;
        if (res.status === false) {
          setError("Transaction reverted on-chain.");
          setPhase("error");
          return;
        }
        if (res.status === true && res.confirmations >= CONFIRMATIONS_NEEDED) {
          setPhase("confirmed");
          toast.success(
            mode === "private"
              ? "Sent privately. Receiver can Sync to see it."
              : "Sent.",
          );
          return;
        }
      } catch {
        // transient; keep polling
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, txHash, chainId, rpc, mode]);

  const onConfirm = async () => {
    if (chainId === null || !recipient || amountWei === null) return;
    if (!gas?.gasPriceWei) {
      setError("Gas price not loaded yet — try again in a moment.");
      return;
    }
    setError(null);

    try {
      if (mode === "private") {
        await runPrivate();
      } else {
        await runPublic();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const runPrivate = async () => {
    if (
      chainId === null ||
      !deployment ||
      !recipient ||
      recipient.kind !== "private" ||
      amountWei === null ||
      !gas?.gasPriceWei
    ) {
      throw new Error("Private send not ready");
    }
    if (!merkle.tree) throw new Error("Merkle tree still loading");
    // Capture into a local so TS preserves the non-null narrowing
    // inside the async closure that runs the proof gen.
    const tree = merkle.tree;
    if (!inputNote) {
      throw new Error(
        "No spendable shielded note covers this amount yet. Try a smaller amount, or shield more first.",
      );
    }

    const noteAmount = BigInt(inputNote.amount);
    const sendAmount = amountWei;
    const change = noteAmount - sendAmount;

    const outputs = [
      {
        poseidonOwner: recipient.poseidon,
        envelopePubKey: recipient.envelope,
        asset: inputNote.asset,
        amount: sendAmount,
      },
    ];
    if (change > 0n) {
      outputs.push({
        poseidonOwner: selfPoseidon,
        envelopePubKey: selfEnvelopePubKey,
        asset: inputNote.asset,
        amount: change,
      });
    }

    // Single PRF ceremony covers BOTH proof gen (needs walletPrivateKey
    // for the input note's owner_secret) and broadcast signing. The
    // unlocked wallet is yielded to this closure; everything that
    // needs the secret happens inside.
    setPhase("signing");
    const { prep, signed } = await withUnlockedWallet(async (wallet) => {
      setPhase("preparing");
      const prep = await prepareTransfer({
        chainId,
        pampaloAddress: deployment.pampaloAddress,
        inputNotes: [
          {
            asset: inputNote.asset,
            amount: noteAmount,
            secret: inputNote.secret,
            owner: inputNote.owner,
            leafIndex: inputNote.leafIndex!,
          },
        ],
        outputs,
        walletPrivateKey: wallet.privateKey,
        tree,
      });

      console.groupCollapsed(
        `%c[transfer-prep]%c proof ready on chain ${chainId}`,
        "color:#0a7;font-weight:bold",
        "color:inherit",
      );
      console.log("inputs", {
        noteLeafCommitment: inputNote.leafCommitment,
        noteLeafIndex: inputNote.leafIndex,
        noteAmount: noteAmount.toString(),
        asset: inputNote.asset,
      });
      console.log(
        "outputs",
        outputs.map((o) => ({
          poseidonOwner: o.poseidonOwner,
          envelopePubKey: o.envelopePubKey.slice(0, 12) + "…",
          asset: o.asset,
          amount: o.amount.toString(),
        })),
      );
      console.log("publicInputs", prep.publicInputs);
      console.log("spentNullifiers", prep.spentNullifiers);
      console.log(
        "outputCommitments",
        prep.outputs.map((o) => o.leafCommitment),
      );
      console.log("tx", {
        to: prep.to,
        value: prep.value,
        gasLimit: TRANSFER_GAS_LIMIT.toString(),
        dataLength: prep.data.length,
        data: prep.data,
      });
      console.log("payload (ECIES blobs)", prep.payload);
      console.groupEnd();

      const nonceRes = await rpc.getNonce(chainId, evmAddress);
      const useEip1559 = gas.priorityFeeWei !== undefined;
      const baseGasPriceWei = BigInt(gas.gasPriceWei);
      const maxPriorityFeePerGas =
        useEip1559 && gas.priorityFeeWei !== undefined
          ? BigInt(gas.priorityFeeWei)
          : undefined;
      const maxFeePerGas = useEip1559 ? baseGasPriceWei : undefined;
      const legacyGasPrice = useEip1559 ? undefined : baseGasPriceWei;

      const signed = await wallet.signTransaction({
        chainId,
        to: prep.to,
        value: 0n,
        data: prep.data,
        nonce: Number(nonceRes.nonce),
        gasLimit: TRANSFER_GAS_LIMIT,
        gasPrice: useEip1559 ? undefined : legacyGasPrice,
        maxFeePerGas: useEip1559 ? maxFeePerGas : undefined,
        maxPriorityFeePerGas: useEip1559 ? maxPriorityFeePerGas : undefined,
        type: useEip1559 ? 2 : undefined,
      });
      return { prep, signed };
    });

    setPhase("broadcasting");
    const { txHash: hash } = await rpc.sendRawTransaction(chainId, signed);
    setTxHash(hash);

    console.log(
      `%c[transfer-broadcast]%c chain ${chainId} txHash %c${hash}`,
      "color:#0a7;font-weight:bold",
      "color:inherit",
      "color:#06f;text-decoration:underline",
    );

    // Optimistic IDB: mark the input note spent, append the self-change
    // output as spendable. The recipient's output is NOT written here —
    // that's the receiver's job via the Sync trial-decrypt path.
    await patchNoteByLeaf(inputNote.leafCommitment, {
      state: "spent",
      spentTxHash: hash,
      nullifier: prep.spentNullifiers[0],
    });
    for (const out of prep.outputs) {
      if (out.owner.toLowerCase() === selfPoseidon.toLowerCase()) {
        await appendNote({
          asset: out.asset,
          assetDecimals: inputNote.assetDecimals,
          amount: out.amount,
          owner: out.owner,
          secret: "0x" + BigInt(out.secret).toString(16).padStart(64, "0"),
          networkChainId: chainId,
          deploymentAddress: deployment.pampaloAddress,
          leafCommitment: out.leafCommitment,
          origin: "transferIn",
          state: "spendable",
          queuedTxHash: hash,
        });
      }
    }

    setPhase("submitted");
  };

  const runPublic = async () => {
    if (
      chainId === null ||
      !recipient ||
      recipient.kind !== "public" ||
      amountWei === null ||
      !gas?.gasPriceWei
    ) {
      throw new Error("Public send not ready");
    }

    setPhase("signing");
    const nonceRes = await rpc.getNonce(chainId, evmAddress);
    const useEip1559 = gas.priorityFeeWei !== undefined;
    const baseGasPriceWei = BigInt(gas.gasPriceWei);
    const maxPriorityFeePerGas =
      useEip1559 && gas.priorityFeeWei !== undefined
        ? BigInt(gas.priorityFeeWei)
        : undefined;
    const maxFeePerGas = useEip1559 ? baseGasPriceWei : undefined;
    const legacyGasPrice = useEip1559 ? undefined : baseGasPriceWei;

    const signed = await signTransactionWithPasskey({
      chainId,
      to: recipient.address,
      value: amountWei,
      data: "0x",
      nonce: Number(nonceRes.nonce),
      gasLimit: PUBLIC_SEND_GAS_LIMIT,
      gasPrice: legacyGasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    setPhase("broadcasting");
    const { txHash: hash } = await rpc.sendRawTransaction(chainId, signed);
    setTxHash(hash);
    setPhase("submitted");
  };

  const inFlight =
    phase === "preparing" || phase === "signing" || phase === "broadcasting";
  const isSuccessPanel = phase === "submitted" || phase === "confirmed";

  // Canonical ETH display — round-trip through formatEther so a USD-
  // mode amount shows as the actual ETH that will move on-chain.
  const ethDisplay =
    amountWei !== null ? trimEthDisplay(formatEther(amountWei)) : "0";

  const confirmLabel = (() => {
    switch (phase) {
      case "preparing":
        return "Preparing proof…";
      case "signing":
        return "Awaiting passkey…";
      case "broadcasting":
        return "Broadcasting…";
      case "error":
        return "Try again";
      default:
        return `Send ${ethDisplay} ETH`;
    }
  })();

  return (
    <div className="flex flex-col gap-4 px-5 pt-2 pb-5 sm:px-6 sm:pt-3 sm:pb-6">
      {!isSuccessPanel && (
        <button
          type="button"
          onClick={onBack}
          disabled={inFlight}
          className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-ink-mute hover:text-ink disabled:opacity-50"
        >
          <ChevronLeft className="size-4" /> Back
        </button>
      )}

      {isSuccessPanel ? (
        <SuccessPanel
          mode={mode}
          phase={phase}
          txHash={txHash}
          chainId={chainId}
          amount={ethDisplay}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="flex flex-col items-center gap-2 text-center">
            <h2 className="font-serif text-[22px] font-bold tracking-[-0.01em] text-ink">
              Review transaction
            </h2>
            <p className="text-[12.5px] text-ink-mute">
              Confirm the details before sending.
            </p>
          </div>

          <div className="mt-1 flex flex-col items-center gap-1.5">
            <AssetMark symbol="ETH" size={44} />
            <p className="font-serif text-[28px] font-bold text-ink">
              {ethDisplay} ETH
            </p>
            {ethUsdPrice && amountWei !== null && (
              <p className="text-[12px] text-ink-mute font-mono">
                ≈ ${(
                  Number(formatEther(amountWei)) * ethUsdPrice
                ).toFixed(2)}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-line bg-paper-lo px-4 py-3">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-[12.5px]">
              <dt className="text-ink-mute">From</dt>
              <dd
                className={cn(
                  "justify-self-end inline-flex items-center gap-1.5 font-semibold",
                  accent === "priv"
                    ? "text-[var(--priv)]"
                    : "text-[var(--pub)]",
                )}
              >
                {mode === "private" ? (
                  <MoonIcon className="size-3" />
                ) : (
                  <SunIcon className="size-3" />
                )}
                {mode === "private" ? "Shielded balance" : "Public balance"}
              </dd>
              <dt className="text-ink-mute">Network</dt>
              <dd className="justify-self-end inline-flex items-center gap-1.5">
                {chainId !== null && (
                  <NetworkLogo chainId={chainId} size={14} />
                )}
                <span className="font-mono text-ink">
                  {deployment?.networkName ??
                    (chainId === 84532 ? "Base Sepolia" : `chain ${chainId}`)}
                </span>
              </dd>
              <dt className="text-ink-mute">To</dt>
              {recipient?.kind === "public" ? (
                <dd className="justify-self-end font-mono text-ink truncate">
                  {recipient.address}
                </dd>
              ) : recipient?.kind === "private" ? (
                <dd className="justify-self-end flex flex-col items-end gap-0.5 font-mono text-ink">
                  <span className="text-[11px] text-ink-mute">
                    Poseidon · {shortKey(recipient.poseidon)}
                  </span>
                  <span className="text-[11px] text-ink-mute">
                    Envelope · {shortKey(recipient.envelope)}
                  </span>
                </dd>
              ) : (
                <dd className="justify-self-end">—</dd>
              )}
            </dl>
          </div>

          <div
            className={cn(
              "rounded-2xl px-3.5 py-2.5 text-[12.5px]",
              mode === "private"
                ? "bg-[var(--priv-soft)] text-[var(--priv)]"
                : "bg-[var(--pub-soft)] text-[var(--pub)]",
            )}
          >
            {mode === "private" ? (
              <>
                Shielded — only the recipient can decrypt this. Amount and
                recipient stay hidden on-chain.
              </>
            ) : (
              <>
                This transfer is visible on-chain and can&apos;t be reversed.
              </>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-[var(--pub-soft-2)] bg-[var(--pub-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--pub)]">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={onConfirm}
            disabled={inFlight}
            className={cn(
              "inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-full",
              "text-[14px] font-bold text-white shadow-sm",
              accent === "priv"
                ? "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]"
                : "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {inFlight && (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            )}
            {!inFlight && <Send className="size-4" />}
            <span className="truncate">{confirmLabel}</span>
          </button>
        </>
      )}
    </div>
  );
}

function trimEthDisplay(raw: string): string {
  if (!raw.includes(".")) return raw;
  let s = raw.replace(/0+$/, "").replace(/\.$/, "");
  const dot = s.indexOf(".");
  if (dot >= 0 && s.length - dot - 1 > 6) {
    s = s.slice(0, dot + 7);
  }
  return s;
}

function shortKey(hex: string): string {
  if (!hex.startsWith("0x") || hex.length < 14) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

function SuccessPanel({
  mode,
  phase,
  txHash,
  chainId,
  amount,
  onClose,
}: {
  mode: SendMode;
  phase: "submitted" | "confirmed";
  txHash: string | null;
  chainId: number | null;
  amount: string;
  onClose: () => void;
}) {
  const accent = mode === "private" ? "priv" : "pub";
  const isConfirmed = phase === "confirmed";
  const explorer = txHash && chainId !== null ? txUrl(chainId, txHash) : null;

  const headline = isConfirmed
    ? mode === "private"
      ? "Sent privately!"
      : "Sent!"
    : "Sending…";

  const subcopy = isConfirmed
    ? mode === "private"
      ? "Transfer mined. Receiver can tap Sync to discover the note."
      : "Transfer mined."
    : "Awaiting confirmation — should land in a few seconds.";

  return (
    <div className="flex flex-col items-center gap-4 px-2 pt-2 text-center">
      <div className="relative inline-flex size-16 items-center justify-center">
        <span
          className={cn(
            "absolute inset-0 rounded-full",
            accent === "priv"
              ? "bg-[var(--priv-soft)]"
              : "bg-[var(--pub-soft)]",
            !isConfirmed && "animate-pulse",
          )}
          aria-hidden
        />
        {isConfirmed ? (
          <CheckCircle2
            className={cn(
              "relative size-10",
              accent === "priv"
                ? "text-[var(--priv)]"
                : "text-[var(--pub)]",
            )}
            aria-hidden
          />
        ) : (
          <>
            <Sparkles
              className={cn(
                "absolute size-10 opacity-40",
                accent === "priv"
                  ? "text-[var(--priv)]"
                  : "text-[var(--pub)]",
              )}
              aria-hidden
            />
            <Loader2
              className={cn(
                "relative size-9 animate-spin",
                accent === "priv"
                  ? "text-[var(--priv)]"
                  : "text-[var(--pub)]",
              )}
              aria-hidden
            />
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="font-serif text-[20px] font-bold text-ink">
          {headline}
        </h3>
        <p className="text-[13px] text-ink-mute max-w-[340px]">{subcopy}</p>
        <p className="font-serif text-[18px] font-bold text-ink mt-1">
          {amount} ETH
        </p>
      </div>

      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper-lo px-3 py-1.5 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-paper hover:text-ink"
        >
          View transaction
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}

      <button
        type="button"
        onClick={onClose}
        className={cn(
          "mt-2 inline-flex h-[44px] w-full items-center justify-center rounded-full",
          isConfirmed
            ? cn(
                "text-white shadow-sm font-bold text-[14px]",
                accent === "priv"
                  ? "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]"
                  : "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
              )
            : "border border-line bg-transparent text-[13.5px] font-semibold text-ink hover:bg-paper-lo",
        )}
      >
        {isConfirmed ? "Done" : "Close"}
      </button>
    </div>
  );
}

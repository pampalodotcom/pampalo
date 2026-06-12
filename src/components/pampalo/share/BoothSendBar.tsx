import { useMemo, useState, useSyncExternalStore } from "react";
import { parseUnits } from "ethers";
import { useQuery } from "convex/react";
import { Loader2, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { useDeploymentRoles } from "@/lib/use-deployment-roles";
import { useRpcClient } from "@/lib/rpc";
import { useMerkleTree } from "@/lib/use-merkle-tree";
import {
  signTransactionWithPasskey,
  withUnlockedWallet,
} from "@/lib/auth-flow";
import { buildSendTx } from "@/lib/send-tx";
import { prepareTransfer } from "@/lib/transfer-prep";
import {
  broadcastPrivate,
  BroadcastCancelledError,
} from "@/lib/private-broadcast";
import { normalizeBroadcastError } from "@/lib/broadcast-error";
import { ETH_SENTINEL } from "@/lib/eth";
import { txUrl } from "@/lib/explorer";
import {
  appendNote,
  getNotesSnapshot,
  isNoteOnActiveDeployment,
  isNotesHydrated,
  patchNoteByLeaf,
  subscribeNotes,
} from "@/lib/idb-notes";
import { useSelfBroadcastFallback } from "@/components/pampalo/SelfBroadcastFallback";
import { cn } from "@/lib/utils";

// Booth-operator quick-drip for the public /share page.
//
// Flow: a booth operator (on-chain BOOTH_OPERATOR_ROLE) scans an
// attendee's share QR with their phone camera, landing on
// /share?e=…&k=…&o=…&c=… while signed in. This bar then offers a
// one-tap "$1.00" drip — public (1 USDC to their EVM address) or
// private ($1-of-ETH shielded transfer to their Poseidon/envelope).
//
// The send logic mirrors send/SendReviewStep.tsx's runPublic/runPrivate
// faithfully (same gas/nonce/EIP-1559 handling, same prepareTransfer +
// broadcastPrivate + optimistic IDB writes), but it's driven by toasts
// instead of a review panel so the operator can clear a queue fast.
//
// Caveats baked into the UX:
//   - "$1.00" public = 1 USDC. Private has no USDC shielding yet, so
//     private = $1-WORTH of ETH at the live eth/usd feed, and needs a
//     spendable shielded ETH note + a synced wallet.
//   - Private self-broadcasts on non-sponsoring chains; Base Sepolia
//     sponsors, so the booth's address stays off-chain there.

const PUBLIC_SEND_GAS_LIMIT_ERC20 = 100_000n;
const TRANSFER_GAS_LIMIT = 8_000_000n;

type Triple = { evm: string; envelope: string; poseidon: string };
type Target = { evm?: string; envelope?: string; poseidon?: string };

/** Gate: only renders the (hook-heavy) buttons for a signed-in booth
 *  operator on the link's chain. Everyone else gets nothing, so the
 *  page stays the plain public share surface it was. */
export function BoothSendBar({
  chainId,
  target,
}: {
  chainId: number | null;
  target: Target;
}) {
  const auth = useAuth();
  const addresses =
    auth.state.status === "authenticated" ? auth.state.addresses : null;
  const signedInEvm = addresses?.evm ?? null;
  const roles = useDeploymentRoles(chainId, signedInEvm);

  if (!addresses || chainId === null) return null;
  if (!roles?.boothOperator) return null;

  return (
    <BoothSendButtons chainId={chainId} account={addresses} target={target} />
  );
}

function BoothSendButtons({
  chainId,
  account,
  target,
}: {
  chainId: number;
  account: Triple;
  target: Target;
}) {
  const rpc = useRpcClient();
  const fallback = useSelfBroadcastFallback(account.evm);

  const hasPublicTarget = Boolean(target.evm);
  const hasPrivateTarget = Boolean(target.poseidon && target.envelope);

  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const gasQ = useQuery(api.prices.gas.latestForChain, { chainId });
  const prices = useQuery(api.prices.feeds.listLatest, {});
  const tokens = useQuery(api.catalog.tokens.list, {});
  const merkle = useMerkleTree(chainId, hasPrivateTarget);
  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () =>
    getNotesSnapshot(),
  );

  const usdc = useMemo(
    () =>
      tokens?.find(
        (t) => t.chainId === chainId && t.symbol.toUpperCase() === "USDC",
      ) ?? null,
    [tokens, chainId],
  );

  const ethUsd = useMemo<number | null>(() => {
    const feed = prices?.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  }, [prices]);

  const deployment = useMemo(
    () => deployments?.find((d) => d.chainId === chainId) ?? null,
    [deployments, chainId],
  );

  // $1 of ETH in wei, at the live feed price. Private has no USDC path.
  const privateAmountWei = useMemo<bigint | null>(() => {
    if (!ethUsd || ethUsd <= 0) return null;
    try {
      return parseUnits((1 / ethUsd).toFixed(18), 18);
    } catch {
      return null;
    }
  }, [ethUsd]);

  // First spendable shielded ETH note that covers $1. Single-input
  // only, same as the demo send path.
  const inputNote = useMemo(() => {
    if (!hasPrivateTarget || privateAmountWei === null) return null;
    if (!isNotesHydrated()) return null;
    return (
      notes.find(
        (n) =>
          n.state === "spendable" &&
          n.networkChainId === chainId &&
          // Retired-deployment notes are unspendable (ADR 0018).
          isNoteOnActiveDeployment(n, deployments) &&
          n.asset === ETH_SENTINEL &&
          n.leafIndex !== undefined &&
          BigInt(n.amount) >= privateAmountWei,
      ) ?? null
    );
  }, [hasPrivateTarget, privateAmountWei, notes, chainId, deployments]);

  const [busy, setBusy] = useState<null | "public" | "private">(null);

  const sendPublic = async () => {
    if (busy) return;
    if (!target.evm) return void toast.error("No address on this link.");
    if (!usdc) return void toast.error("USDC isn't configured on this chain.");
    if (!gasQ?.gasPriceWei)
      return void toast.error("Gas price not loaded yet — try again.");

    const id = "booth-public";
    setBusy("public");
    toast.loading("Sending $1.00…", { id });
    try {
      const amountWei = parseUnits("1", usdc.decimals);
      const nonceRes = await rpc.getNonce(chainId, account.evm);
      const useEip1559 = gasQ.priorityFeeWei !== undefined;
      const baseGasPriceWei = BigInt(gasQ.gasPriceWei);
      const skeleton = buildSendTx({
        tokenAddress: usdc.address,
        recipient: target.evm.toLowerCase(),
        amountWei,
      });
      const signed = await signTransactionWithPasskey({
        chainId,
        to: skeleton.to,
        value: BigInt(skeleton.value),
        data: skeleton.data,
        nonce: Number(nonceRes.nonce),
        gasLimit: PUBLIC_SEND_GAS_LIMIT_ERC20,
        gasPrice: useEip1559 ? undefined : baseGasPriceWei,
        maxFeePerGas: useEip1559 ? baseGasPriceWei : undefined,
        maxPriorityFeePerGas:
          useEip1559 && gasQ.priorityFeeWei !== undefined
            ? BigInt(gasQ.priorityFeeWei)
            : undefined,
      });
      const { txHash } = await rpc.sendRawTransaction(chainId, signed);
      toast.success("Sent $1.00 publicly", {
        id,
        description: shortAddr(target.evm),
        action: explorerAction(chainId, txHash),
      });
    } catch (e) {
      const n = normalizeBroadcastError(e);
      toast.error("Couldn't send", { id, description: n.friendly });
    } finally {
      setBusy(null);
    }
  };

  const sendPrivate = async () => {
    if (busy) return;
    if (!hasPrivateTarget || !target.poseidon || !target.envelope)
      return void toast.error("This link has no private identifier.");
    if (!deployment)
      return void toast.error("No Pampalo deployment for this chain.");
    if (privateAmountWei === null)
      return void toast.error("ETH price not loaded yet — try again.");
    if (!gasQ?.gasPriceWei)
      return void toast.error("Gas price not loaded yet — try again.");
    if (!merkle.tree)
      return void toast.error("Merkle tree still loading — try again.");
    if (!isNotesHydrated())
      return void toast.error("Open your wallet and Sync first, then retry.");
    if (!inputNote)
      return void toast.error(
        "No shielded ETH note covers $1.00 — shield some ETH first.",
      );

    const tree = merkle.tree;
    const note = inputNote;
    const id = "booth-private";
    setBusy("private");
    toast.loading("Preparing private $1.00…", { id });
    try {
      const noteAmount = BigInt(note.amount);
      const sendAmount = privateAmountWei;
      const change = noteAmount - sendAmount;

      const outputs = [
        {
          poseidonOwner: target.poseidon,
          envelopePubKey: target.envelope,
          asset: note.asset,
          amount: sendAmount,
        },
      ];
      if (change > 0n) {
        outputs.push({
          poseidonOwner: account.poseidon,
          envelopePubKey: account.envelope,
          asset: note.asset,
          amount: change,
        });
      }

      // One PRF ceremony covers proof gen (needs the owner secret) and
      // self-broadcast signing — same as SendReviewStep.runPrivate.
      const { prep, signed } = await withUnlockedWallet(async (wallet) => {
        const builtPrep = await prepareTransfer({
          chainId,
          pampaloAddress: deployment.pampaloAddress,
          inputNotes: [
            {
              asset: note.asset,
              amount: noteAmount,
              secret: note.secret,
              owner: note.owner,
              leafIndex: note.leafIndex!,
            },
          ],
          outputs,
          walletPrivateKey: wallet.privateKey,
          tree,
        });

        const nonceRes = await rpc.getNonce(chainId, account.evm);
        const useEip1559 = gasQ.priorityFeeWei !== undefined;
        const baseGasPriceWei = BigInt(gasQ.gasPriceWei);
        const signedTx = await wallet.signTransaction({
          chainId,
          to: builtPrep.to,
          value: 0n,
          data: builtPrep.data,
          nonce: Number(nonceRes.nonce),
          gasLimit: TRANSFER_GAS_LIMIT,
          gasPrice: useEip1559 ? undefined : baseGasPriceWei,
          maxFeePerGas: useEip1559 ? baseGasPriceWei : undefined,
          maxPriorityFeePerGas:
            useEip1559 && gasQ.priorityFeeWei !== undefined
              ? BigInt(gasQ.priorityFeeWei)
              : undefined,
          type: useEip1559 ? 2 : undefined,
        });
        return { prep: builtPrep, signed: signedTx };
      });

      toast.loading("Sending privately…", { id });
      const { txHash } = await broadcastPrivate({
        rpc,
        sponsoring: deployment.sponsoringTxs,
        chainId,
        kind: "transfer",
        proof: prep.proofBytes,
        publicInputs: prep.publicInputs,
        payload: prep.payload,
        signedSelfBroadcast: signed,
        confirmFallback: fallback.confirm,
      });

      // Optimistic IDB: input note spent, self-change appended. The
      // recipient's output is the receiver's job to discover via Sync.
      await patchNoteByLeaf(note.leafCommitment, {
        state: "spent",
        spentTxHash: txHash,
        nullifier: prep.spentNullifiers[0],
      });
      for (const out of prep.outputs) {
        if (out.owner.toLowerCase() === account.poseidon.toLowerCase()) {
          await appendNote({
            asset: out.asset,
            assetDecimals: note.assetDecimals,
            amount: out.amount,
            owner: out.owner,
            secret:
              "0x" + BigInt(out.secret).toString(16).padStart(64, "0"),
            networkChainId: chainId,
            deploymentAddress: deployment.pampaloAddress,
            leafCommitment: out.leafCommitment,
            origin: "transferIn",
            state: "spendable",
            queuedTxHash: txHash,
          });
        }
      }

      toast.success("Sent $1.00 privately", {
        id,
        description: "Tell them to Sync to see it.",
        action: explorerAction(chainId, txHash),
      });
    } catch (e) {
      if (e instanceof BroadcastCancelledError) {
        toast.dismiss(id);
        return;
      }
      const n = normalizeBroadcastError(e);
      toast.error("Couldn't send privately", { id, description: n.friendly });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mt-5 border-t border-line pt-4">
        <div className="mb-2.5 flex items-center justify-between">
          <p className="eyebrow">Booth Operator</p>
          <span className="text-[11px] text-ink-mute">Quick drip · $1.00</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={sendPublic}
            disabled={busy !== null || !hasPublicTarget}
            className={cn(
              "inline-flex h-[46px] items-center justify-center gap-2 rounded-full",
              "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
              "text-[13px] font-bold text-white shadow-sm",
              "transition-opacity hover:opacity-95",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy === "public" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sun className="size-4" />
            )}
            Send $1.00 public
          </button>
          <button
            type="button"
            onClick={sendPrivate}
            disabled={busy !== null || !hasPrivateTarget}
            className={cn(
              "inline-flex h-[46px] items-center justify-center gap-2 rounded-full",
              "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
              "text-[13px] font-bold text-white shadow-sm",
              "transition-opacity hover:opacity-95",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy === "private" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Moon className="size-4" />
            )}
            Send $1.00 private
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-ink-mute">
          Public sends 1&nbsp;USDC to their address. Private sends $1 of
          shielded ETH (needs a synced wallet with a spendable ETH note).
        </p>
      </div>
      {fallback.element}
    </>
  );
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function explorerAction(chainId: number, txHash: string) {
  const url = txUrl(chainId, txHash);
  if (!url) return undefined;
  return {
    label: "View",
    onClick: () => window.open(url, "_blank"),
  };
}

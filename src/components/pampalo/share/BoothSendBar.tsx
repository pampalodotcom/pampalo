import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatEther, parseUnits } from "ethers";
import { useAction, useQuery } from "convex/react";
import { Loader2, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { usePublicBalance } from "@/lib/balances";
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
// /share?e=…&k=…&o=…&c=… while signed in. This bar offers a one-tap
// "$1.00" drip — public ($1 of ETH to their EVM address) or private ($1
// of shielded ETH to their Poseidon/envelope).
//
// Both sends are $1-WORTH of ETH at the live eth/usd feed. The operator
// can pick any chain they hold BOOTH_OPERATOR_ROLE on (Base, Base
// Sepolia, …) — not just the chain encoded in the link.
//
// The send logic mirrors send/SendReviewStep.tsx's runPublic/runPrivate
// (same gas/nonce/EIP-1559 handling, same prepareTransfer +
// broadcastPrivate + optimistic IDB writes), driven by toasts so the
// operator can clear a queue fast. Private self-broadcasts on
// non-sponsoring chains; sponsoring chains keep the booth's address off-
// chain.

const PUBLIC_SEND_GAS_LIMIT_NATIVE = 21_000n;
const TRANSFER_GAS_LIMIT = 8_000_000n;

type Triple = { evm: string; envelope: string; poseidon: string };
type Target = { evm?: string; envelope?: string; poseidon?: string };

/** Resolve the set of chainIds (among `chains`) on which `evm` holds
 *  BOOTH_OPERATOR_ROLE. Returns null while loading. One hasRoles probe
 *  per chain — fine for the 1–2 chains we run. */
function useBoothChains(
  chains: number[],
  evm: string | null,
): Set<number> | null {
  const fetcher = useAction(api.shieldQueue.proxy.hasRoles);
  const [result, setResult] = useState<Set<number> | null>(null);
  const key = chains.join(",");

  useEffect(() => {
    if (!evm || chains.length === 0) {
      setResult(new Set());
      return;
    }
    const controller = new AbortController();
    void Promise.all(
      chains.map((chainId) =>
        fetcher({ chainId, user: evm })
          .then((r) => ({ chainId, ok: Boolean(r?.boothOperator) }))
          .catch(() => ({ chainId, ok: false })),
      ),
    ).then((rows) => {
      if (controller.signal.aborted) return;
      setResult(new Set(rows.filter((r) => r.ok).map((r) => r.chainId)));
    });
    return () => {
      controller.abort();
    };
    // `key` is the chains array joined — re-probes when the set changes.
  }, [key, evm, fetcher]);

  return result;
}

/** Gate: only renders the (hook-heavy) booth panel for a signed-in
 *  operator who holds the role on at least one enabled chain. Everyone
 *  else gets nothing, so the page stays the plain public share surface. */
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

  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const chainIds = useMemo(
    () => deployments?.map((d) => d.chainId) ?? [],
    [deployments],
  );
  const boothChains = useBoothChains(chainIds, signedInEvm);

  if (!addresses) return null;
  if (!deployments || boothChains === null) return null; // loading
  if (boothChains.size === 0) return null; // not a booth operator anywhere

  return (
    <BoothSendPanel
      deployments={deployments}
      boothChains={boothChains}
      linkChainId={chainId}
      account={addresses}
      target={target}
    />
  );
}

type DeploymentRow = {
  chainId: number;
  networkName: string;
  pampaloAddress: string;
  sponsoringTxs: boolean;
};

function BoothSendPanel({
  deployments,
  boothChains,
  linkChainId,
  account,
  target,
}: {
  deployments: DeploymentRow[];
  boothChains: Set<number>;
  linkChainId: number | null;
  account: Triple;
  target: Target;
}) {
  // Chains the operator can actually drip on, in catalog order.
  const chains = useMemo(
    () => deployments.filter((d) => boothChains.has(d.chainId)),
    [deployments, boothChains],
  );

  // `chains` is non-empty here: the parent only renders BoothSendPanel when
  // boothChains.size > 0, and boothChains ⊆ the deployment chainIds.
  const [selected, setSelected] = useState<number>(() =>
    linkChainId !== null && boothChains.has(linkChainId)
      ? linkChainId
      : chains[0].chainId,
  );
  // Keep the selection valid if the available set changes.
  useEffect(() => {
    if (!chains.some((c) => c.chainId === selected) && chains[0]) {
      setSelected(chains[0].chainId);
    }
  }, [chains, selected]);

  const deployment = chains.find((c) => c.chainId === selected) ?? null;
  if (!deployment) return null;

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2.5 flex items-center justify-between">
        <p className="eyebrow">Booth Operator</p>
        <span className="text-[11px] text-ink-mute">Quick drip · $1.00</span>
      </div>

      {chains.length > 1 && (
        <div className="mb-3 inline-flex rounded-full border border-line bg-card p-0.5">
          {chains.map((c) => (
            <button
              key={c.chainId}
              type="button"
              onClick={() => setSelected(c.chainId)}
              className={cn(
                "rounded-full px-3 py-1 text-[12px] font-semibold transition-colors",
                selected === c.chainId
                  ? "bg-ink text-paper"
                  : "text-ink-soft hover:text-ink",
              )}
            >
              {c.networkName}
            </button>
          ))}
        </div>
      )}

      <BoothSendButtons
        key={selected}
        deployment={deployment}
        account={account}
        target={target}
      />
    </div>
  );
}

function BoothSendButtons({
  deployment,
  account,
  target,
}: {
  deployment: DeploymentRow;
  account: Triple;
  target: Target;
}) {
  const chainId = deployment.chainId;
  const rpc = useRpcClient();
  const fallback = useSelfBroadcastFallback(account.evm);

  const hasPublicTarget = Boolean(target.evm);
  const hasPrivateTarget = Boolean(target.poseidon && target.envelope);

  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const gasQ = useQuery(api.prices.gas.latestForChain, { chainId });
  const prices = useQuery(api.prices.feeds.listLatest, {});
  const merkle = useMerkleTree(chainId, hasPrivateTarget);
  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () =>
    getNotesSnapshot(),
  );
  const ethToken = useMemo(
    () => ({
      chainId,
      address: ETH_SENTINEL,
      symbol: "ETH",
      decimals: 18,
    }),
    [chainId],
  );
  const publicBal = usePublicBalance(ethToken, account.evm);

  const ethUsd = useMemo<number | null>(() => {
    const feed = prices?.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  }, [prices]);

  // $1 of ETH in wei, at the live feed price — the amount for BOTH sends.
  const dripWei = useMemo<bigint | null>(() => {
    if (!ethUsd || ethUsd <= 0) return null;
    try {
      return parseUnits((1 / ethUsd).toFixed(18), 18);
    } catch {
      return null;
    }
  }, [ethUsd]);

  // Spendable shielded ETH on this chain's live deployment.
  const privSpendableWei = useMemo<bigint>(() => {
    if (!isNotesHydrated()) return 0n;
    let sum = 0n;
    for (const n of notes) {
      if (
        n.state === "spendable" &&
        n.networkChainId === chainId &&
        isNoteOnActiveDeployment(n, deployments) &&
        n.asset === ETH_SENTINEL
      ) {
        sum += BigInt(n.amount);
      }
    }
    return sum;
  }, [notes, chainId, deployments]);

  // First spendable shielded ETH note that covers $1 (single-input).
  const inputNote = useMemo(() => {
    if (!hasPrivateTarget || dripWei === null) return null;
    if (!isNotesHydrated()) return null;
    return (
      notes.find(
        (n) =>
          n.state === "spendable" &&
          n.networkChainId === chainId &&
          isNoteOnActiveDeployment(n, deployments) &&
          n.asset === ETH_SENTINEL &&
          n.leafIndex !== undefined &&
          BigInt(n.amount) >= dripWei,
      ) ?? null
    );
  }, [hasPrivateTarget, dripWei, notes, chainId, deployments]);

  const publicBalWei = publicBal.data?.balanceWei ?? null;
  const publicAffordable =
    publicBalWei !== null && dripWei !== null && publicBalWei >= dripWei;

  const [busy, setBusy] = useState<null | "public" | "private">(null);

  const sendPublic = async () => {
    if (busy) return;
    if (!target.evm) return void toast.error("No address on this link.");
    if (dripWei === null)
      return void toast.error("ETH price not loaded yet — try again.");
    if (!gasQ?.gasPriceWei)
      return void toast.error("Gas price not loaded yet — try again.");
    if (!publicAffordable)
      return void toast.error("Not enough public ETH for a $1 drip.");

    const id = "booth-public";
    setBusy("public");
    toast.loading("Sending $1.00…", { id });
    try {
      const nonceRes = await rpc.getNonce(chainId, account.evm);
      const useEip1559 = gasQ.priorityFeeWei !== undefined;
      const baseGasPriceWei = BigInt(gasQ.gasPriceWei);
      // $1 of native ETH → a plain value transfer.
      const skeleton = buildSendTx({
        tokenAddress: ETH_SENTINEL,
        recipient: target.evm.toLowerCase(),
        amountWei: dripWei,
      });
      const signed = await signTransactionWithPasskey({
        chainId,
        to: skeleton.to,
        value: BigInt(skeleton.value),
        data: skeleton.data,
        nonce: Number(nonceRes.nonce),
        gasLimit: PUBLIC_SEND_GAS_LIMIT_NATIVE,
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
    if (dripWei === null)
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
      const sendAmount = dripWei;
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
            secret: "0x" + BigInt(out.secret).toString(16).padStart(64, "0"),
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
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={sendPublic}
          disabled={busy !== null || !hasPublicTarget || !publicAffordable}
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

      {/* Available-to-send per mode. Columns line up under the buttons. */}
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] leading-snug text-ink-mute">
        <span>
          {publicBal.isLoading || publicBalWei === null
            ? "Public ETH: …"
            : `Public: ${fmtEth(publicBalWei)} ETH${usdSuffix(publicBalWei, ethUsd)} available`}
        </span>
        <span>
          {`Shielded: ${fmtEth(privSpendableWei)} ETH${usdSuffix(privSpendableWei, ethUsd)} spendable`}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-ink-mute">
        Each drip sends $1 of ETH — publicly to their address, or privately as
        a shielded transfer (needs a synced wallet with a spendable ETH note).
      </p>
      {fallback.element}
    </>
  );
}

function fmtEth(wei: bigint): string {
  // 4 significant decimals is plenty for a $1-scale drip readout.
  return Number(formatEther(wei)).toFixed(4);
}

function usdSuffix(wei: bigint, ethUsd: number | null): string {
  if (!ethUsd || ethUsd <= 0) return "";
  const usd = Number(formatEther(wei)) * ethUsd;
  return ` (~$${usd.toFixed(2)})`;
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

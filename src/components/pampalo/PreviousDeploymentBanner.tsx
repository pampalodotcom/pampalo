import { useMemo, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { History, ArrowRight } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  getNotesSnapshot,
  isNoteRetired,
  subscribeNotes,
} from "@/lib/idb-notes";
import { usePrivateBalances } from "@/lib/use-private-balances";
import { cn } from "@/lib/utils";

// ADR 0022/0024 — post-migration nudge. The instant a deployment is cut over,
// a user's notes on the old contract become *retired* and drop out of the
// active balance. If they have **nothing on the new contract** (active
// spendable == 0) **but** still hold value-bearing notes on the previous
// deployment, they'd otherwise see an empty wallet with no hint that their
// funds are recoverable. This surfaces that, linking to the eject flow under
// Account → Previous deployments.
//
// Deliberately narrow: it only shows when active balance is exactly zero, so
// a user who has already re-shielded (or partially migrated) isn't nagged.

export function PreviousDeploymentBanner({
  evmAddress,
}: {
  evmAddress: string | null;
}) {
  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () =>
    getNotesSnapshot(),
  );
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const { perAsset, hydrating } = usePrivateBalances(evmAddress);

  const show = useMemo(() => {
    if (hydrating || !deployments) return false;
    // Per-chain, not global: a user can hold balance on one chain while another
    // chain is freshly migrated-and-empty. Active spendable summed per chain.
    const activeByChain = new Map<number, bigint>();
    for (const b of perAsset) {
      activeByChain.set(
        b.chainId,
        (activeByChain.get(b.chainId) ?? 0n) + b.spendable,
      );
    }
    // Chains that carry a value-bearing note on a previous (retired) deployment.
    const retiredChains = new Set<number>();
    for (const n of notes) {
      if (!isNoteRetired(n, deployments)) continue;
      if (
        n.state === "spent" ||
        n.state === "cancelled" ||
        n.state === "contested"
      ) {
        continue;
      }
      if (BigInt(n.amount) <= 0n) continue;
      retiredChains.add(n.networkChainId);
    }
    // Show if any such chain has zero active spendable balance.
    for (const chainId of retiredChains) {
      if ((activeByChain.get(chainId) ?? 0n) === 0n) return true;
    }
    return false;
  }, [perAsset, hydrating, deployments, notes]);

  if (!show) return null;

  return (
    <Link
      to="/account"
      className={cn(
        "flex items-center gap-3 rounded-3xl card-cream px-5 py-4",
        "transition-colors hover:bg-paper-lo",
      )}
    >
      <span
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-paper-lo text-ink-mute"
        aria-hidden
      >
        <History className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-ink">
          You have notes in a previous Pampalo deployment
        </p>
        <p className="text-[12.5px] text-ink-soft">
          The contract was upgraded. Withdraw them to your wallet from your
          account.
        </p>
      </div>
      <ArrowRight className="size-4 shrink-0 text-ink-mute" aria-hidden />
    </Link>
  );
}

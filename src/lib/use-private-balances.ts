import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  getNotesSnapshot,
  isNotesHydrated,
  subscribeNotes,
  type StoredNote,
} from "./idb-notes";

// Reads the IDB notes facade and surfaces the three private-balance
// buckets the wallet UI needs:
//
//   spendable          — `state === "spendable"`
//   pendingQueued      — `state === "queued"` and `unlockTime > now`
//   pendingExecutable  — `state === "queued"` and `unlockTime <= now`
//                        (user can tap Finalise; CTA-bucket)
//
// Spent / cancelled / contested notes are activity events, not
// balance state — they don't appear in any bucket here. See
// SHIELD_FLOW.md §3.3 for the framing rationale.
//
// Re-renders:
//   - On every IDB write (via the module-scoped notify() in idb-notes).
//   - Cross-tab via the BroadcastChannel inside the facade.
//   - On exact `unlockTime` for each queued note (clock-tick scheduler
//     below). Cleared on unmount + on every note-list change.

export type PendingNote = {
  leafCommitment: string;
  amount: bigint;
  unlockTime: number; // unix seconds
  /** Chain this note lives on — drives block-explorer link resolution. */
  chainId: number;
  /** Tx that queued the leaf. Undefined until the optimistic write
   *  or the Convex sync writer fills it in. */
  queuedTxHash?: string;
};

export type AssetBucket = {
  chainId: number;
  deploymentAddress: string;
  asset: string;
  decimals: number;

  spendable: bigint;
  pendingQueued: bigint;
  pendingExecutable: bigint;

  queuedNotes: PendingNote[];
  executableNotes: PendingNote[];
};

export type UsePrivateBalancesResult = {
  perAsset: AssetBucket[];
  hydrating: boolean;
};

const EMPTY_RESULT: UsePrivateBalancesResult = {
  perAsset: [],
  hydrating: true,
};

export function usePrivateBalances(): UsePrivateBalancesResult {
  // Snapshot of notes from the IDB facade.
  const notes = useSyncExternalStore(
    subscribeNotes,
    getNotesSnapshot,
    () => getNotesSnapshot(), // SSR snapshot — wallet routes auth-gate before rendering anyway
  );

  // Clock-tick scheduler. We need the hook to re-derive `executable`
  // the moment any queued note's unlockTime passes — even if no IDB
  // write happens. Track a counter; bump on each timeout to force a
  // re-render. `notes` itself can't carry the trigger because it's
  // unchanged by the passage of time.
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const handles: number[] = [];
    for (const n of notes) {
      if (n.state !== "queued") continue;
      if (n.unlockTime === undefined) continue;
      const targetMs = n.unlockTime * 1000;
      const delta = targetMs - now;
      if (delta <= 0) continue; // already executable; nothing to schedule
      // Cap at 24h so we don't hold a giant timeout that survives
      // suspend/resume cycles into the next month.
      const wait = Math.min(delta + 250, 24 * 3600_000);
      const handle = window.setTimeout(() => {
        forceRerender((tick) => tick + 1);
      }, wait);
      handles.push(handle);
    }
    return () => {
      for (const h of handles) window.clearTimeout(h);
    };
  }, [notes]);

  return useMemo<UsePrivateBalancesResult>(() => {
    if (!isNotesHydrated()) return EMPTY_RESULT;
    return aggregate(notes);
  }, [notes]);
}

// ─── Pure aggregation (testable in isolation later) ─────────────────────

function aggregate(
  notes: readonly StoredNote[],
): UsePrivateBalancesResult {
  const now = Date.now();
  // Bucket by `${chainId}:${deploymentAddress}:${asset}`.
  const buckets = new Map<string, AssetBucket>();
  for (const n of notes) {
    if (n.state === "spent") continue;
    if (n.state === "cancelled" || n.state === "contested") continue;

    const key = `${n.networkChainId}:${n.deploymentAddress}:${n.asset}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        chainId: n.networkChainId,
        deploymentAddress: n.deploymentAddress,
        asset: n.asset,
        decimals: n.assetDecimals,
        spendable: 0n,
        pendingQueued: 0n,
        pendingExecutable: 0n,
        queuedNotes: [],
        executableNotes: [],
      };
      buckets.set(key, b);
    }
    const amount = BigInt(n.amount);
    if (n.state === "spendable") {
      b.spendable += amount;
      continue;
    }
    // Remaining state must be "queued" — `spent` / `cancelled` /
    // `contested` were filtered above.
    const unlock = (n.unlockTime ?? Number.POSITIVE_INFINITY) * 1000;
    const isExecutable = unlock <= now;
    const pendingNote: PendingNote = {
      leafCommitment: n.leafCommitment,
      amount,
      unlockTime: n.unlockTime ?? 0,
      chainId: n.networkChainId,
      queuedTxHash: n.queuedTxHash,
    };
    if (isExecutable) {
      b.pendingExecutable += amount;
      b.executableNotes.push(pendingNote);
    } else {
      b.pendingQueued += amount;
      b.queuedNotes.push(pendingNote);
    }
  }
  return {
    perAsset: Array.from(buckets.values()),
    hydrating: false,
  };
}

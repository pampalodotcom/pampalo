import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
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
// Cross-device queued-shield hydration: when an evmAddress is passed,
// the hook also subscribes to `shieldQueue.store.byShielder` and merges
// any queued/executable rows whose `leafCommitment` is missing from
// IDB into the appropriate bucket as a view-only PendingNote. This is
// the path that surfaces a finalise CTA on Device B (or after an IDB
// wipe on Device A) before the envelope-key cache + decrypt path
// lands. The synthetic rows do NOT contribute to `spendable` because
// we can't spend a note we can't decrypt.
//
// Re-renders:
//   - On every IDB write (via the module-scoped notify() in idb-notes).
//   - Cross-tab via the BroadcastChannel inside the facade.
//   - On every Convex `byShielder` snapshot when evmAddress is set.
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

export function usePrivateBalances(
  evmAddress: string | null,
): UsePrivateBalancesResult {
  // Snapshot of notes from the IDB facade.
  const notes = useSyncExternalStore(
    subscribeNotes,
    getNotesSnapshot,
    () => getNotesSnapshot(), // SSR snapshot — wallet routes auth-gate before rendering anyway
  );

  // Cross-device hydration. Convex returns queued/executed/cancelled/
  // contested rows for this shielder; we merge the queued ones that
  // aren't already in IDB into the buckets as view-only entries.
  const convexRows = useQuery(
    api.shieldQueue.store.byShielder,
    evmAddress ? { shielder: evmAddress } : "skip",
  );
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});

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
    // Same clock-tick logic for the Convex overlay rows that haven't
    // landed in IDB yet — without these timeouts the hook would
    // silently miss the queued→executable transition on cross-device
    // rows.
    if (convexRows && deployments) {
      const idbLeaves = new Set(
        notes.map((n) => n.leafCommitment.toLowerCase()),
      );
      for (const row of convexRows) {
        if (row.state !== "queued") continue;
        if (idbLeaves.has(row.leafCommitment.toLowerCase())) continue;
        const targetMs = row.unlockTime * 1000;
        const delta = targetMs - now;
        if (delta <= 0) continue;
        const wait = Math.min(delta + 250, 24 * 3600_000);
        const handle = window.setTimeout(() => {
          forceRerender((tick) => tick + 1);
        }, wait);
        handles.push(handle);
      }
    }
    return () => {
      for (const h of handles) window.clearTimeout(h);
    };
  }, [notes, convexRows, deployments]);

  return useMemo<UsePrivateBalancesResult>(() => {
    if (!isNotesHydrated()) return EMPTY_RESULT;
    return aggregate(notes, convexRows ?? null, deployments ?? null);
  }, [notes, convexRows, deployments]);
}

// ─── Pure aggregation (testable in isolation later) ─────────────────────

function aggregate(
  notes: readonly StoredNote[],
  convexRows: Doc<"shieldQueueEntries">[] | null,
  deployments: Array<{
    _id: string;
    chainId: number;
    pampaloAddress: string;
  }> | null,
): UsePrivateBalancesResult {
  const now = Date.now();
  // Bucket by `${chainId}:${deploymentAddress}:${asset}`.
  const buckets = new Map<string, AssetBucket>();
  const idbLeaves = new Set<string>();
  for (const n of notes) {
    idbLeaves.add(n.leafCommitment.toLowerCase());
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

  // Convex overlay — surface queued/executable shields that this
  // device has no local IDB note for. The synthetic PendingNotes ride
  // in the same buckets so the wallet's per-asset slider already
  // groups them by (chainId, asset). decimals on the bucket is a
  // placeholder when no IDB note seeded the bucket; AssetRow always
  // overrides with `asset.decimals` from the catalog when rendering
  // PendingShieldsList, so the placeholder is never read for display.
  if (convexRows && deployments) {
    const chainByDeployment = new Map<
      string,
      { chainId: number; address: string }
    >();
    for (const d of deployments) {
      chainByDeployment.set(d._id, {
        chainId: d.chainId,
        address: d.pampaloAddress.toLowerCase(),
      });
    }
    for (const row of convexRows) {
      if (row.state !== "queued") continue;
      if (idbLeaves.has(row.leafCommitment.toLowerCase())) continue;
      const dep = chainByDeployment.get(row.deploymentId);
      if (!dep) continue; // deployment was disabled — drop the overlay row
      const asset = row.asset.toLowerCase();
      const key = `${dep.chainId}:${dep.address}:${asset}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          chainId: dep.chainId,
          deploymentAddress: dep.address,
          asset,
          decimals: 0, // placeholder — AssetRow overrides for display
          spendable: 0n,
          pendingQueued: 0n,
          pendingExecutable: 0n,
          queuedNotes: [],
          executableNotes: [],
        };
        buckets.set(key, b);
      }
      const amount = BigInt(row.amount);
      const isExecutable = row.unlockTime * 1000 <= now;
      const pendingNote: PendingNote = {
        leafCommitment: row.leafCommitment,
        amount,
        unlockTime: row.unlockTime,
        chainId: dep.chainId,
        queuedTxHash: row.queuedTxHash,
      };
      if (isExecutable) {
        b.pendingExecutable += amount;
        b.executableNotes.push(pendingNote);
      } else {
        b.pendingQueued += amount;
        b.queuedNotes.push(pendingNote);
      }
    }
  }

  return {
    perAsset: Array.from(buckets.values()),
    hydrating: false,
  };
}

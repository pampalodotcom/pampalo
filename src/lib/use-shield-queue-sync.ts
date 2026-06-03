import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { findNote, patchNoteByLeaf, type NoteState } from "./idb-notes";

// Same-device Convex → IDB sync writer. Subscribes to the user's own
// shield-queue mirror (`shieldQueueEntries.byShielder`) and walks every
// snapshot, applying forward-only state transitions to IDB notes that
// the wallet already knows about (i.e. the optimistic write happened
// here on this device when the user broadcast their shield).
//
// Cross-device hydration — where Device B sees a row it has no IDB
// note for — is deferred until the envelope-private-key cache lands
// (SHIELD_FLOW.md §3.4 "Cold-start hydration"). For now, unknown
// leaves are skipped with a debug log.
//
// State name mapping between Convex and IDB notes:
//
//   Convex          IDB note
//   ─────────       ──────────
//   queued      →   queued
//   executed    →   spendable
//   cancelled   →   cancelled
//   contested   →   contested
//
// Per SHIELD_FLOW.md §3.4 the rule is "always advance, never retract."

type ConvexState = Doc<"shieldQueueEntries">["state"];

const ADVANCEMENT_RANK: Record<NoteState, number> = {
  queued: 0,
  spendable: 1,
  cancelled: 1,
  contested: 1,
  spent: 2,
};

function convexStateToIdb(s: ConvexState): NoteState {
  return s === "executed" ? "spendable" : s;
}

export function useShieldQueueSync(evmAddress: string | null): void {
  const rows = useQuery(
    api.shieldQueue.store.byShielder,
    evmAddress ? { shielder: evmAddress } : "skip",
  );

  useEffect(() => {
    if (!rows) return;
    void reconcile(rows);
  }, [rows]);
}

async function reconcile(rows: Doc<"shieldQueueEntries">[]): Promise<void> {
  for (const row of rows) {
    const existing = await findNote(row.leafCommitment);
    if (!existing) {
      // Cross-device case (Device B has no local IDB note for this
      // leaf) — deferred until the decrypt path lands. Skip silently.
      continue;
    }

    const targetIdbState = convexStateToIdb(row.state);
    if (ADVANCEMENT_RANK[targetIdbState] <= ADVANCEMENT_RANK[existing.state]) {
      // Forward-only — no retraction, no redundant write. Includes the
      // common case where IDB already mirrors Convex exactly.
      // Still patch identity fields if Convex has a more accurate
      // value than the optimistic write captured. unlockTime: the
      // optimistic write used (now + shieldWaitSeconds) as an
      // approximation; the indexer wrote the actual chain-timestamp
      // based value. queuedTxHash: optimistic writes will have it
      // already, but cross-device hydration won't — patch when we see
      // it for the first time so the wallet's block-explorer link
      // works on every device.
      const patch: Record<string, unknown> = {};
      if (existing.unlockTime !== row.unlockTime) {
        patch.unlockTime = row.unlockTime;
      }
      if (
        existing.queuedTxHash?.toLowerCase() !== row.queuedTxHash.toLowerCase()
      ) {
        patch.queuedTxHash = row.queuedTxHash;
      }
      if (Object.keys(patch).length > 0) {
        await patchNoteByLeaf(row.leafCommitment, patch);
      }
      continue;
    }

    // State advanced. Apply the patch.
    await patchNoteByLeaf(row.leafCommitment, {
      state: targetIdbState,
      unlockTime: row.unlockTime,
      queuedTxHash: row.queuedTxHash,
    });
  }
}

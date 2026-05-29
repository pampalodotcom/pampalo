// IDB store for shield-queue lifecycle metadata. One record per
// browser profile holds the per-pending-shield state the wallet UI
// surfaces (countdown timer, finalise CTA, cancel button, red row on
// cancel/contest). Each row FK's a corresponding `idb-notes.ts` row
// by `leafCommitment` — the universal note tuple lives over there;
// this store holds only the shield-specific lifecycle bits.
//
// On-chain authoritative state lives in `Pampalo.pendingShields[id]`
// and the Convex `shieldQueueEntries` mirror. This local copy is a
// cache that gets reconciled against the Convex reactive query.
// See SHIELD_FLOW.md §3.2.

import { del, get, set } from "idb-keyval";

const KEY = "pampalo:shieldQueueEntries:v1";

export type ShieldQueueState =
  | "queued"
  | "executed"
  | "cancelled"
  | "contested";

export type StoredShieldQueueEntry = {
  networkChainId: number;
  deploymentAddress: string; // lowercased Pampalo contract address
  pendingId: string;          // decimal string of uint256
  leafCommitment: string;     // FK into pampalo:notes:v1; lowercased

  queuedTxHash: string;       // lowercased
  queuedAt: number;           // ms — wall clock when the wallet first saw it
  unlockTime: number;         // unix seconds — chain timestamp + shieldWaitTime
  usdCentsCharged: number;    // for display ("This shield used $X of your cap")

  state: ShieldQueueState;
  // Populated on resolution. resolvedAt anchors the 72h ack window
  // (see SHIELD_FLOW.md §8).
  resolvedTxHash?: string;    // lowercased
  resolvedBy?: string;        // lowercased
  resolvedAt?: number;        // unix seconds
  contestReason?: string;     // only when state == contested
};

type Record = {
  entries: StoredShieldQueueEntry[];
};

async function read(): Promise<Record> {
  const rec = await get<Record>(KEY);
  if (!rec) return { entries: [] };
  return rec;
}

async function write(rec: Record): Promise<void> {
  await set(KEY, rec);
}

function normalise(
  entry: StoredShieldQueueEntry,
): StoredShieldQueueEntry {
  return {
    ...entry,
    deploymentAddress: entry.deploymentAddress.toLowerCase(),
    leafCommitment: entry.leafCommitment.toLowerCase(),
    queuedTxHash: entry.queuedTxHash.toLowerCase(),
    resolvedTxHash: entry.resolvedTxHash?.toLowerCase(),
    resolvedBy: entry.resolvedBy?.toLowerCase(),
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────

export async function listShieldQueueEntries(): Promise<
  StoredShieldQueueEntry[]
> {
  const rec = await read();
  return rec.entries;
}

export async function findShieldQueueEntryByLeaf(
  leafCommitment: string,
): Promise<StoredShieldQueueEntry | undefined> {
  const target = leafCommitment.toLowerCase();
  const rec = await read();
  return rec.entries.find(
    (e) => e.leafCommitment.toLowerCase() === target,
  );
}

export async function findShieldQueueEntryByPendingId(
  deploymentAddress: string,
  pendingId: string,
): Promise<StoredShieldQueueEntry | undefined> {
  const deployment = deploymentAddress.toLowerCase();
  const rec = await read();
  return rec.entries.find(
    (e) =>
      e.deploymentAddress.toLowerCase() === deployment &&
      e.pendingId === pendingId,
  );
}

// ─── Writes ──────────────────────────────────────────────────────────────

/**
 * Insert a new shield-queue entry. Idempotent on `leafCommitment` so
 * the optimistic write at TX-submit time and the Convex reactive
 * delivery converge without flicker.
 */
export async function appendShieldQueueEntry(
  entry: StoredShieldQueueEntry,
): Promise<StoredShieldQueueEntry> {
  const rec = await read();
  const target = entry.leafCommitment.toLowerCase();
  const existing = rec.entries.find(
    (e) => e.leafCommitment.toLowerCase() === target,
  );
  if (existing) return existing;
  const stored = normalise(entry);
  rec.entries.push(stored);
  await write(rec);
  return stored;
}

/**
 * Partial update by `leafCommitment`. Drives the state machine from
 * the Convex reactive query and from the local executeShield /
 * cancelShield TX-receipt parse.
 */
export async function patchShieldQueueEntryByLeaf(
  leafCommitment: string,
  patch: Partial<StoredShieldQueueEntry>,
): Promise<StoredShieldQueueEntry | undefined> {
  const target = leafCommitment.toLowerCase();
  const rec = await read();
  const idx = rec.entries.findIndex(
    (e) => e.leafCommitment.toLowerCase() === target,
  );
  if (idx === -1) return undefined;
  const merged = normalise({ ...rec.entries[idx]!, ...patch });
  rec.entries[idx] = merged;
  await write(rec);
  return merged;
}

/** Wipe path — used by /clear. */
export async function clearShieldQueueEntries(): Promise<void> {
  await del(KEY);
}

// Universal IDB store for Pampalo notes. One record per browser
// profile holds every note the wallet knows about — shield-origin and
// (future) transferIn-origin — keyed by their on-chain `leafCommitment`.
//
// Source of truth for the user's *own* dashboard view. The Convex
// `shieldQueueEntries` table is the cross-device propagation channel +
// the only source the public `/sentry` view reads; the wallet reads
// IDB and treats Convex as a background hydrate / reconciliation feed.
// See SHIELD_FLOW.md §3.1 + CLIENT_SIDE_FIRST.md.
//
// Notes are reconstructible from `(Convex shieldQueueEntries + the
// user's envelope key)`, so a 7-day Safari IDB wipe is non-fatal: a
// fresh device fetches the encrypted payloads from Convex, decrypts
// with the passkey-derived envelope key, and rehydrates this store.

import { del, get, set } from "idb-keyval";

const KEY = "pampalo:notes:v1";

/** The four-tuple plus spend state — see CONTEXT.md "Note". */
export type NoteState =
  | "queued"
  | "spendable"
  | "spent"
  | "cancelled"
  | "contested";

export type StoredNote = {
  // Canonical four-tuple. `secret` is per-note unlinkable random.
  asset: string;          // lowercased EVM address
  assetDecimals: number;
  amount: string;         // base units, decimal string (uint256-safe)
  owner: string;          // Poseidon identifier (0x + 64 hex). v1: always self.
  secret: string;         // 0x + 64 hex; never leaves the device unencrypted

  // Where it lives in the protocol.
  networkChainId: number;
  deploymentAddress: string; // lowercased Pampalo contract address
  leafCommitment: string;    // 0x + 64 hex; primary key in this store
  origin: "shield" | "transferIn";

  // Spend lifecycle.
  state: NoteState;
  // Populated when executeShield mines and the leaf lands in the tree:
  treeIndex?: number;
  leafIndex?: number;
  // Populated when this note is spent (transfer-out or unshield):
  nullifier?: string;
  spentTxHash?: string;

  // Local-only UI state — see SHIELD_FLOW.md §3.1. Never synced.
  acknowledgedAt?: number; // ms — set when user dismisses a red row
};

type Record = {
  notes: StoredNote[];
};

async function read(): Promise<Record> {
  const rec = await get<Record>(KEY);
  if (!rec) return { notes: [] };
  return rec;
}

async function write(rec: Record): Promise<void> {
  await set(KEY, rec);
}

// ─── Reads ───────────────────────────────────────────────────────────────

export async function listNotes(): Promise<StoredNote[]> {
  const rec = await read();
  return rec.notes;
}

export async function findNote(
  leafCommitment: string,
): Promise<StoredNote | undefined> {
  const target = leafCommitment.toLowerCase();
  const rec = await read();
  return rec.notes.find((n) => n.leafCommitment.toLowerCase() === target);
}

/** Sum of `amount` (in base units) across notes matching the filter. */
export async function sumNoteAmounts(filter: {
  asset?: string;
  networkChainId?: number;
  state?: NoteState;
}): Promise<bigint> {
  const rec = await read();
  let sum = 0n;
  const asset = filter.asset?.toLowerCase();
  for (const n of rec.notes) {
    if (filter.state && n.state !== filter.state) continue;
    if (asset && n.asset.toLowerCase() !== asset) continue;
    if (
      filter.networkChainId !== undefined &&
      n.networkChainId !== filter.networkChainId
    )
      continue;
    sum += BigInt(n.amount);
  }
  return sum;
}

// ─── Writes ──────────────────────────────────────────────────────────────

/**
 * Insert a new note. Idempotent: re-appending the same `leafCommitment`
 * is a no-op and returns the existing row. Convex reconciliation relies
 * on this (the optimistic local write at submit time and the Convex
 * row from the indexer both land here).
 */
export async function appendNote(note: StoredNote): Promise<StoredNote> {
  const rec = await read();
  const existing = rec.notes.find(
    (n) =>
      n.leafCommitment.toLowerCase() === note.leafCommitment.toLowerCase(),
  );
  if (existing) return existing;
  // Normalise on the way in so every read lookups use lowercase consistently.
  const stored: StoredNote = {
    ...note,
    asset: note.asset.toLowerCase(),
    owner: note.owner.toLowerCase(),
    secret: note.secret.toLowerCase(),
    deploymentAddress: note.deploymentAddress.toLowerCase(),
    leafCommitment: note.leafCommitment.toLowerCase(),
    nullifier: note.nullifier?.toLowerCase(),
    spentTxHash: note.spentTxHash?.toLowerCase(),
  };
  rec.notes.push(stored);
  await write(rec);
  return stored;
}

/**
 * Partial update by `leafCommitment`. Used for lifecycle transitions
 * (queued → spendable on executeShield receipt, → cancelled / contested
 * via the Convex reactive query, → spent on transfer-out / unshield).
 * Returns the updated row, or undefined if the leaf is unknown.
 */
export async function patchNoteByLeaf(
  leafCommitment: string,
  patch: Partial<StoredNote>,
): Promise<StoredNote | undefined> {
  const target = leafCommitment.toLowerCase();
  const rec = await read();
  const idx = rec.notes.findIndex(
    (n) => n.leafCommitment.toLowerCase() === target,
  );
  if (idx === -1) return undefined;
  const merged = { ...rec.notes[idx]!, ...patch };
  rec.notes[idx] = merged;
  await write(rec);
  return merged;
}

/**
 * Nuke-everything path. Called by `/clear` alongside the existing
 * `wipePrefsCompletely()` and `clearTransactions()`. Not used in
 * normal flows.
 */
export async function clearNotes(): Promise<void> {
  await del(KEY);
}

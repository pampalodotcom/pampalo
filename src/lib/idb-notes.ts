// Universal IDB store for Pampalo notes. One record per browser
// profile holds every note the wallet knows about — shield-origin and
// (future) transferIn-origin — keyed by their on-chain `leafCommitment`.
//
// Source of truth for the user's *own* dashboard view. The Convex
// `shieldQueueEntries` table is the cross-device propagation channel +
// the only source the public `/sentry` view reads; the wallet reads
// IDB and treats Convex as a background hydrate / reconciliation feed.
// See SHIELD_FLOW.md §3.1–§3.4 + CLIENT_SIDE_FIRST.md.
//
// Notes are reconstructible from `(Convex shieldQueueEntries + the
// user's envelope key)`, so a 7-day Safari IDB wipe is non-fatal: a
// fresh device fetches the encrypted payloads from Convex, decrypts
// with the passkey-derived envelope key, and rehydrates this store.
//
// ─── Reader facade ──────────────────────────────────────────────────────
//
// IDB doesn't push change events to readers. Every write goes through
// this module's facade, which keeps a `cache: StoredNote[] | null`
// in process, hydrates lazily from IDB on first read, and calls
// `notify()` on a Set of subscribers after every mutation. The
// `usePrivateBalances` hook subscribes via `useSyncExternalStore`.
//
// A `BroadcastChannel("pampalo:notes")` syncs the cache across tabs
// on the same browser profile so a shield from Tab A shows up in
// Tab B without a reload. Same listener pattern as
// `src/lib/preferences.ts`.

import { del, get, set } from "idb-keyval";

// IDB is keyed per-wallet so two passkeys registered on the same
// browser profile (e.g. ben@hooper.link + a test account) never see
// each other's notes. The key embeds the wallet's lowercased EVM
// address; reads return EMPTY until `setActiveWallet` is called on
// sign-in. See AUTH.md threat model + the per-wallet scoping notes.
const KEY_PREFIX = "pampalo:notes:v2:";
const CHANNEL_NAME = "pampalo:notes";

let activeWallet: string | null = null;

function activeKey(): string | null {
  return activeWallet ? KEY_PREFIX + activeWallet : null;
}

/** The four-tuple plus spend state — see CONTEXT.md "Note". */
export type NoteState =
  | "queued"
  | "spendable"
  | "spent"
  | "cancelled"
  | "contested";

export type StoredNote = {
  // Canonical four-tuple. `secret` is per-note unlinkable random.
  asset: string; // lowercased EVM address
  assetDecimals: number;
  amount: string; // base units, decimal string (uint256-safe)
  owner: string; // Poseidon identifier (0x + 64 hex). v1: always self.
  secret: string; // 0x + 64 hex; never leaves the device unencrypted

  // Where it lives in the protocol.
  networkChainId: number;
  deploymentAddress: string; // lowercased Pampalo contract address
  leafCommitment: string; // 0x + 64 hex; primary key in this store
  origin: "shield" | "transferIn";

  // Spend lifecycle.
  state: NoteState;
  // chain timestamp of unlock — needed for the client-derived
  // `executable` sub-state of `queued`. Unix seconds.
  unlockTime?: number;
  // Tx that queued this leaf (the `shield` / `shieldNative` call).
  // Populated at optimistic-write time from the broadcast receipt; also
  // patched by the Convex sync writer when it sees the canonical row.
  queuedTxHash?: string;
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

// ─── Module-scoped cache + listener bus ─────────────────────────────────

let cache: readonly StoredNote[] | null = null;
let hydratePromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

const channel: BroadcastChannel | null =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;
if (channel) {
  channel.addEventListener("message", (e) => {
    // Another tab mutated IDB — invalidate our cache so the next read
    // pulls fresh. Cheap: a single IDB round-trip, then notify().
    if (e.data === "changed") {
      void refresh();
    }
  });
}

function notify(): void {
  for (const l of listeners) l();
}

async function readFromIdb(): Promise<Record> {
  const key = activeKey();
  if (!key) return { notes: [] };
  const rec = await get<Record>(key);
  if (!rec) return { notes: [] };
  return rec;
}

async function writeToIdb(rec: Record): Promise<void> {
  const key = activeKey();
  if (!key) {
    throw new Error(
      "idb-notes: cannot write before setActiveWallet — caller should gate on auth state",
    );
  }
  await set(key, rec);
}

async function refresh(): Promise<void> {
  const rec = await readFromIdb();
  cache = rec.notes;
  notify();
}

function ensureHydrated(): Promise<void> {
  // No active wallet → hydrate as empty so React subscribers don't
  // hang on an unresolved promise. They re-hydrate when setActiveWallet
  // fires.
  if (!activeWallet) {
    if (cache === null) cache = EMPTY;
    return Promise.resolve();
  }
  if (cache !== null) return Promise.resolve();
  if (!hydratePromise) hydratePromise = refresh();
  return hydratePromise;
}

/**
 * Bind the notes facade to a wallet. Call from auth-flow whenever
 * sign-in / re-auth / bootstrap resolves with an address; call with
 * `null` on sign-out. Switching from one wallet to another nukes the
 * in-memory cache and triggers a fresh hydrate from that wallet's
 * bucket, so React subscribers transition cleanly.
 */
export function setActiveWallet(address: string | null): void {
  const next = address ? address.toLowerCase() : null;
  if (next === activeWallet) return;
  activeWallet = next;
  cache = null;
  hydratePromise = null;
  notify();
  if (next) {
    // Kick off the hydrate — subscribers' next snapshot read finds the
    // new wallet's data.
    void ensureHydrated();
  }
}

/** Read-only view, for debugging / observability. */
export function getActiveWallet(): string | null {
  return activeWallet;
}

function broadcast(): void {
  if (channel) channel.postMessage("changed");
}

/**
 * React subscription handle. Pair with `getNotesSnapshot` for
 * `useSyncExternalStore`.
 */
export function subscribeNotes(listener: () => void): () => void {
  listeners.add(listener);
  // Kick off the lazy hydrate so subscribers see real data on the
  // first commit instead of an empty list followed by a re-render.
  void ensureHydrated();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Synchronous snapshot for `useSyncExternalStore`. Returns an empty
 * array before the lazy hydrate resolves; subscribers will receive a
 * notify() once the cache is populated.
 */
export function getNotesSnapshot(): readonly StoredNote[] {
  return cache ?? EMPTY;
}
const EMPTY: readonly StoredNote[] = Object.freeze([]);

/** True once `cache` has been populated from IDB at least once. */
export function isNotesHydrated(): boolean {
  return cache !== null;
}

// ─── Reads (legacy async helpers — keep for callers outside React) ─────

export async function listNotes(): Promise<StoredNote[]> {
  await ensureHydrated();
  return cache !== null ? Array.from(cache) : [];
}

export async function findNote(
  leafCommitment: string,
): Promise<StoredNote | undefined> {
  await ensureHydrated();
  const target = leafCommitment.toLowerCase();
  return cache?.find((n) => n.leafCommitment === target);
}

/** Sum of `amount` (in base units) across notes matching the filter. */
export async function sumNoteAmounts(filter: {
  asset?: string;
  networkChainId?: number;
  state?: NoteState;
}): Promise<bigint> {
  await ensureHydrated();
  let sum = 0n;
  const asset = filter.asset?.toLowerCase();
  for (const n of cache ?? []) {
    if (filter.state && n.state !== filter.state) continue;
    if (asset && n.asset !== asset) continue;
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

function normalise(note: StoredNote): StoredNote {
  return {
    ...note,
    asset: note.asset.toLowerCase(),
    owner: note.owner.toLowerCase(),
    secret: note.secret.toLowerCase(),
    deploymentAddress: note.deploymentAddress.toLowerCase(),
    leafCommitment: note.leafCommitment.toLowerCase(),
    queuedTxHash: note.queuedTxHash?.toLowerCase(),
    nullifier: note.nullifier?.toLowerCase(),
    spentTxHash: note.spentTxHash?.toLowerCase(),
  };
}

/**
 * Insert a new note. Idempotent: re-appending the same `leafCommitment`
 * is a no-op and returns the existing row. Convex reconciliation relies
 * on this (the optimistic local write at submit time and the Convex
 * row from the indexer both land here).
 */
export async function appendNote(note: StoredNote): Promise<StoredNote> {
  await ensureHydrated();
  const stored = normalise(note);
  const existing = cache?.find(
    (n) => n.leafCommitment === stored.leafCommitment,
  );
  if (existing) return existing;
  const next = [...(cache ?? []), stored];
  await writeToIdb({ notes: next });
  cache = next;
  notify();
  broadcast();
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
  await ensureHydrated();
  const target = leafCommitment.toLowerCase();
  const idx = cache?.findIndex((n) => n.leafCommitment === target) ?? -1;
  if (idx === -1 || cache === null) return undefined;
  const merged = normalise({ ...cache[idx], ...patch });
  const next = cache.slice();
  next[idx] = merged;
  await writeToIdb({ notes: next });
  cache = next;
  notify();
  broadcast();
  return merged;
}

/**
 * Nuke-everything path. Called by `/clear` alongside the existing
 * `wipePrefsCompletely()` and `clearTransactions()`. Not used in
 * normal flows. Scoped to the active wallet's bucket — other wallets'
 * notes on this device are untouched.
 */
export async function clearNotes(): Promise<void> {
  const key = activeKey();
  if (!key) {
    cache = EMPTY;
    notify();
    return;
  }
  await del(key);
  cache = EMPTY;
  notify();
  broadcast();
}

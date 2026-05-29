// Per-stream sync cursors. Lets the wallet skip Convex rows it has
// already attempted to decrypt — a small wedge to avoid re-doing work
// on every page load.
//
// Today there is one cursor: `shieldQueueLastQueuedAt` (ms epoch of the
// newest `queuedAt` we've already processed via byShielder). Transfer-in
// scanning will add a sibling cursor when that lands. See SHIELD_FLOW.md
// §3.4 "Cold-start hydration" and CLIENT_SIDE_FIRST.md for the broader
// IDB-is-truth posture.

import { get, set } from "idb-keyval";

// Keyed per-wallet so a multi-passkey browser profile keeps each
// wallet's sync watermarks separate. See idb-notes.ts for the wider
// "per-wallet IDB scoping" rationale.
const KEY_PREFIX = "pampalo:sync-cursor:v2:";

function cursorKey(walletAddress: string): string {
  return KEY_PREFIX + walletAddress.toLowerCase();
}

export type SyncCursor = {
  /** Highest `queuedAt` (ms) we've already iterated for the shield queue. */
  shieldQueueLastQueuedAt?: number;
};

export async function readSyncCursor(
  walletAddress: string,
): Promise<SyncCursor> {
  const rec = await get<SyncCursor>(cursorKey(walletAddress));
  return rec ?? {};
}

export async function writeSyncCursor(
  walletAddress: string,
  patch: SyncCursor,
): Promise<void> {
  const key = cursorKey(walletAddress);
  const current = (await get<SyncCursor>(key)) ?? {};
  await set(key, { ...current, ...patch });
}

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

const KEY = "pampalo:sync-cursor:v1";

export type SyncCursor = {
  /** Highest `queuedAt` (ms) we've already iterated for the shield queue. */
  shieldQueueLastQueuedAt?: number;
};

export async function readSyncCursor(): Promise<SyncCursor> {
  const rec = await get<SyncCursor>(KEY);
  return rec ?? {};
}

export async function writeSyncCursor(patch: SyncCursor): Promise<void> {
  const current = (await get<SyncCursor>(KEY)) ?? {};
  await set(KEY, { ...current, ...patch });
}

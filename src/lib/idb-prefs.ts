// Single-record IDB wrapper for the encrypted-preferences sync flow.
// See CLIENT_SIDE_FIRST.md.
//
// IDB is the on-device source of truth for preferences. The record holds
// the cleartext prefs object, the last server revision we've seen for this
// user, a snapshot of the prefs as last synced with the server, and a
// `dirty` flag derived by diffing `data` against `lastSynced` — so a
// change that's later changed back reads as clean, not as un-pushed work.
//
// Single global key: we assume one signed-in user per browser profile at a
// time (same assumption the keystore makes). Signing out clears the record.

import { del, get, set } from "idb-keyval";

const KEY = "pampalo:preferences:v1";

export type PrefsRecord<T> = {
  data: T;
  lastSeenRevision: number | null;
  dirty: boolean;
  // What the server held at the last successful pull/push. Optional for
  // back-compat with records written before this field existed (those
  // fall back to the stored `dirty` flag until the next sync).
  lastSynced?: T | null;
};

export async function readPrefsRecord<T>(): Promise<
  PrefsRecord<T> | undefined
> {
  return await get<PrefsRecord<T>>(KEY);
}

export async function writePrefsRecord<T>(
  record: PrefsRecord<T>,
): Promise<void> {
  await set(KEY, record);
}

export async function clearPrefsRecord(): Promise<void> {
  await del(KEY);
}

// Single-record IDB wrapper for the encrypted-preferences sync flow.
// See CLIENT_SIDE_FIRST.md.
//
// IDB is the on-device source of truth for preferences. The record holds
// the cleartext prefs object, the last server revision we've seen for this
// user, and a `dirty` flag set whenever the user mutates a pref and
// cleared on a successful push to Convex.
//
// Single global key: we assume one signed-in user per browser profile at a
// time (same assumption the keystore makes). Signing out clears the record.

import { del, get, set } from "idb-keyval";

const KEY = "pampalo:preferences:v1";

export type PrefsRecord<T> = {
  data: T;
  lastSeenRevision: number | null;
  dirty: boolean;
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

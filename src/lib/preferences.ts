// Client-side-first user preferences. IndexedDB is the source of truth on
// the device; the sync module (preferences-sync.ts) pushes the encrypted
// JSON to Convex during PRF ceremonies. See CLIENT_SIDE_FIRST.md.

import { useSyncExternalStore } from "react";
import {
  clearPrefsRecord,
  readPrefsRecord,
  writePrefsRecord,
} from "./idb-prefs";

// ─── Shape ────────────────────────────────────────────────────────────────

export type DisplayCurrency = "USD" | "AUD" | "GBP" | "CAD";

export type Prefs = {
  showTestnets: boolean;
  defaultChainId?: number;
  displayCurrency?: DisplayCurrency;
  // When the user completed an export of the recovery phrase (Copy or
  // Download in MnemonicReveal), or proved possession by recovering.
  // Monotonic — see mergePrefs(). Drives the PageLayout backup banner.
  // ADR 0013.
  mnemonicBackedUpAt?: number;
};

const DEFAULT_PREFS: Prefs = {
  showTestnets: false,
};

// Testnet chain id set; unchanged from the previous sessionStorage impl.
const TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Sepolia
  421614, // Arbitrum Sepolia
  84532, // Base Sepolia
]);

export function isTestnetChainId(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId);
}

// Field-wise comparison (normalised against defaults so an absent key and
// an explicit default compare equal). `dirty` is derived from this diff
// rather than from "a write happened" — toggling a pref and toggling it
// back must read as clean, not as un-pushed work.
export function prefsEqual(a: Prefs, b: Prefs): boolean {
  const na = { ...DEFAULT_PREFS, ...a };
  const nb = { ...DEFAULT_PREFS, ...b };
  return (
    na.showTestnets === nb.showTestnets &&
    na.defaultChainId === nb.defaultChainId &&
    na.displayCurrency === nb.displayCurrency &&
    na.mnemonicBackedUpAt === nb.mnemonicBackedUpAt
  );
}

// ─── Module-scoped store ──────────────────────────────────────────────────

let cache: Prefs | null = null;
let dirty = false;
let lastSeenRevision: number | null = null;
// Snapshot of the prefs as the server last held them (set on every
// pull/push). Baseline for the dirty diff; null = never synced.
let lastSynced: Prefs | null = null;
let loadPromise: Promise<void> | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

async function loadFromIdb(): Promise<void> {
  if (cache) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const rec = await readPrefsRecord<Prefs>();
    if (rec) {
      cache = { ...DEFAULT_PREFS, ...rec.data };
      lastSynced = rec.lastSynced ?? null;
      // Re-derive dirtiness from the diff when we have a baseline;
      // records written before `lastSynced` existed fall back to the
      // stored flag until their next sync establishes one.
      dirty = lastSynced ? !prefsEqual(cache, lastSynced) : rec.dirty;
      lastSeenRevision = rec.lastSeenRevision;
      notify();
      return;
    }

    // First-time bootstrap. Migrate the previous sessionStorage testnets
    // toggle if present, then persist. If migration changed anything off
    // its default, mark dirty so the next sync pushes the migrated value.
    const migrated: Prefs = { ...DEFAULT_PREFS };
    try {
      if (typeof window !== "undefined") {
        const legacy = window.sessionStorage.getItem("pampalo:showTestnets");
        if (legacy === "1") migrated.showTestnets = true;
        if (legacy !== null) {
          window.sessionStorage.removeItem("pampalo:showTestnets");
        }
      }
    } catch {
      /* private browsing / quota — drop silently */
    }

    const migratedFromDefaults =
      migrated.showTestnets !== DEFAULT_PREFS.showTestnets;
    cache = migrated;
    dirty = migratedFromDefaults;
    lastSeenRevision = null;
    lastSynced = null;
    await writePrefsRecord({
      data: migrated,
      lastSeenRevision: null,
      dirty: migratedFromDefaults,
      lastSynced: null,
    });
    notify();
  })();
  await loadPromise;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  void loadFromIdb();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Prefs {
  return cache ?? DEFAULT_PREFS;
}

function getServerSnapshot(): Prefs {
  return DEFAULT_PREFS;
}

// ─── Hooks + mutators ────────────────────────────────────────────────────

export function usePreferences(): Prefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Reactive accessor for the last-seen server revision — drives the
// "upstream has changes" side of the PageLayout sync banner.
export function useLastSeenRevision(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => lastSeenRevision,
    () => null,
  );
}

// Reactive accessor for the dirty flag — drives the "you have unpushed
// changes" side of the PageLayout sync banner.
export function useIsDirty(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dirty,
    () => false,
  );
}

// True once the IDB record has been read (or bootstrapped). Banners that
// key off pref values must wait for this — otherwise DEFAULT_PREFS
// flashes a "not backed up" state at users who are.
export function usePrefsLoaded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => cache !== null,
    () => false,
  );
}

export function setPref<TKey extends keyof Prefs>(
  key: TKey,
  value: Prefs[TKey],
): void {
  const base = cache ?? DEFAULT_PREFS;
  cache = { ...base, [key]: value };
  // Dirty = "differs from what the server holds", not "a write happened".
  // Changing a pref and changing it back reads as clean — no sync banner.
  // Never-synced (lastSynced null) diffs against defaults: if everything
  // is still default there's nothing worth pushing.
  dirty = !prefsEqual(cache, lastSynced ?? DEFAULT_PREFS);
  void writePrefsRecord({ data: cache, lastSeenRevision, dirty, lastSynced });
  notify();
}

// Existing testnets hook — same shape so callers stay unchanged.
export function useTestnetsEnabled(): [boolean, (value: boolean) => void] {
  const prefs = usePreferences();
  return [prefs.showTestnets, (v) => setPref("showTestnets", v)];
}

// ─── Internals consumed by preferences-sync.ts ───────────────────────────

export function getCurrentPrefsSnapshot(): Prefs {
  return cache ?? DEFAULT_PREFS;
}

export function isDirty(): boolean {
  return dirty;
}

export function getLastSeenRevision(): number | null {
  return lastSeenRevision;
}

export function markPushed(revision: number): void {
  if (!cache) return;
  dirty = false;
  lastSeenRevision = revision;
  lastSynced = cache;
  void writePrefsRecord({
    data: cache,
    lastSeenRevision: revision,
    dirty: false,
    lastSynced,
  });
  notify();
}

// `serverPrefs` is what the server row actually holds (the pre-merge
// upstream value); it becomes the new dirty-diff baseline. When the
// applied value is an upstream+local merge that still differs from it,
// `dirty` stays true and the caller's subsequent push (→ markPushed)
// converges both sides. Defaults to `prefs` for the plain "applied the
// server state verbatim" case.
export function applyPulledPrefs(
  prefs: Prefs,
  revision: number,
  serverPrefs: Prefs = prefs,
): void {
  cache = { ...DEFAULT_PREFS, ...prefs };
  lastSynced = { ...DEFAULT_PREFS, ...serverPrefs };
  dirty = !prefsEqual(cache, lastSynced);
  lastSeenRevision = revision;
  void writePrefsRecord({
    data: cache,
    lastSeenRevision: revision,
    dirty,
    lastSynced,
  });
  notify();
}

// Field-aware merge of upstream and local prefs. Last-write-wins (local
// wins when dirty) is right for toggles like showTestnets, but monotonic
// fields must never move backwards: a stale device pushing its old view
// must not be able to "un-back-up" a wallet. ADR 0013.
export function mergePrefs(
  upstream: Prefs,
  local: Prefs,
  localDirty: boolean,
): Prefs {
  const merged: Prefs = localDirty
    ? { ...upstream, ...local }
    : { ...upstream };
  const backedUpAt = Math.max(
    upstream.mnemonicBackedUpAt ?? 0,
    local.mnemonicBackedUpAt ?? 0,
  );
  if (backedUpAt > 0) merged.mnemonicBackedUpAt = backedUpAt;
  return merged;
}

// Sign-out path. Drops the in-memory cache so the next sign-in reads
// fresh from IDB, but LEAVES the IDB record alone — otherwise any
// preference changes the user made this session would be lost (the push
// to Convex only happens during a PRF ceremony, which sign-out doesn't
// have). The next sign-in's `syncOnSignInComplete` notices the dirty
// IDB record and pushes it. See CLIENT_SIDE_FIRST.md "Multi-user caveat".
export function clearPrefsMemoryForSignOut(): void {
  cache = null;
  dirty = false;
  lastSeenRevision = null;
  lastSynced = null;
  loadPromise = null;
  notify();
}

// /clear-style full wipe — used when the user explicitly resets device
// state (sign-out + nuke local cache). Drops both in-memory cache and
// the IDB record.
export async function wipePrefsCompletely(): Promise<void> {
  cache = null;
  dirty = false;
  lastSeenRevision = null;
  lastSynced = null;
  loadPromise = null;
  await clearPrefsRecord();
  notify();
}

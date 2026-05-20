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
};

const DEFAULT_PREFS: Prefs = {
  showTestnets: false,
};

// Testnet chain id set; unchanged from the previous sessionStorage impl.
const TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Sepolia
  421614, // Arbitrum Sepolia
]);

export function isTestnetChainId(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId);
}

// ─── Module-scoped store ──────────────────────────────────────────────────

let cache: Prefs | null = null;
let dirty = false;
let lastSeenRevision: number | null = null;
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
      dirty = rec.dirty;
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
    await writePrefsRecord({
      data: migrated,
      lastSeenRevision: null,
      dirty: migratedFromDefaults,
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
// "upstream has changes" indicator in the BalanceCard.
export function useLastSeenRevision(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => lastSeenRevision,
    () => null,
  );
}

// Reactive accessor for the dirty flag — drives the "you have unpushed
// changes" side of the BalanceCard sync indicator.
export function useIsDirty(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dirty,
    () => false,
  );
}

export function setPref<TKey extends keyof Prefs>(
  key: TKey,
  value: Prefs[TKey],
): void {
  const base = cache ?? DEFAULT_PREFS;
  cache = { ...base, [key]: value };
  dirty = true;
  void writePrefsRecord({ data: cache, lastSeenRevision, dirty: true });
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
  void writePrefsRecord({ data: cache, lastSeenRevision: revision, dirty: false });
  notify();
}

export function applyPulledPrefs(prefs: Prefs, revision: number): void {
  cache = { ...DEFAULT_PREFS, ...prefs };
  dirty = false;
  lastSeenRevision = revision;
  void writePrefsRecord({ data: cache, lastSeenRevision: revision, dirty: false });
  notify();
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
  loadPromise = null;
  await clearPrefsRecord();
  notify();
}

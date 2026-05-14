// Module-scoped, in-memory keystore for the encrypted blob.
//
// Per AUTH.md §8.3, the encrypted blob is NEVER persisted. Only the
// derived public addresses are mirrored to localStorage (shared across
// tabs) so a hard refresh can show them immediately while a passkey
// re-auth is still needed to actually unlock the wallet for signing.

import type { DerivedAddresses } from "./derive-addresses";

export type EncryptedBlobCredential = {
  credentialId: ArrayBuffer;
  prfSalt: ArrayBuffer;
  wrappedDek: ArrayBuffer;
  wrappedDekIv: ArrayBuffer;
  label: string;
};

export type EncryptedBlob = {
  mnemonicCiphertext: ArrayBuffer;
  mnemonicIv: ArrayBuffer;
  credentials: Array<EncryptedBlobCredential>;
};

const ADDRESSES_KEY = "pampalo:addresses";
// Legacy single-EVM key kept around so existing users don't see a broken
// state on first load after this change. Read once, migrate, then dropped.
const LEGACY_EVM_KEY = "pampalo:address";

function readPersistedAddresses(): DerivedAddresses | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ADDRESSES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DerivedAddresses>;
      if (parsed.evm && parsed.envelope && parsed.poseidon) {
        return parsed as DerivedAddresses;
      }
    }
    // Migration from the previous EVM-only string.
    const legacy = window.localStorage.getItem(LEGACY_EVM_KEY);
    if (legacy) {
      window.localStorage.removeItem(LEGACY_EVM_KEY);
      // We don't have envelope/poseidon yet — return null so the wallet
      // route prompts a re-auth, which will populate the full triple.
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedAddresses(value: DerivedAddresses | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(ADDRESSES_KEY);
    else window.localStorage.setItem(ADDRESSES_KEY, JSON.stringify(value));
  } catch {
    /* localStorage not available; values are non-sensitive, drop silently */
  }
}

let blob: EncryptedBlob | null = null;
let addresses: DerivedAddresses | null = readPersistedAddresses();
let sessionToken: string | null = null;

export function setBlob(b: EncryptedBlob): void {
  blob = b;
}
export function getBlob(): EncryptedBlob | null {
  return blob;
}
export function clearBlob(): void {
  blob = null;
}

export function setAddresses(a: DerivedAddresses): void {
  addresses = a;
  writePersistedAddresses(a);
}
export function getAddresses(): DerivedAddresses | null {
  return addresses;
}
export function clearAddresses(): void {
  addresses = null;
  writePersistedAddresses(null);
}

export function setSessionToken(t: string): void {
  sessionToken = t;
}
export function getSessionToken(): string | null {
  return sessionToken;
}
export function clearSessionToken(): void {
  sessionToken = null;
}

export function clearAll(): void {
  blob = null;
  addresses = null;
  sessionToken = null;
  writePersistedAddresses(null);
}

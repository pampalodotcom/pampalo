// Module-scoped, in-memory keystore for the encrypted blob.
//
// Per AUTH.md §8.3, the encrypted blob is NEVER persisted. Only the
// derived public address is mirrored to localStorage (shared across tabs)
// so a hard refresh can show the address immediately while a passkey
// re-auth is needed to actually unlock the wallet for signing.

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

const ADDRESS_KEY = "pampalo:address";

function readPersistedAddress(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ADDRESS_KEY);
  } catch {
    return null;
  }
}

function writePersistedAddress(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(ADDRESS_KEY);
    else window.localStorage.setItem(ADDRESS_KEY, value);
  } catch {
    /* localStorage not available; address is non-sensitive, drop silently */
  }
}

let blob: EncryptedBlob | null = null;
let address: string | null = readPersistedAddress();
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

export function setAddress(a: string): void {
  address = a;
  writePersistedAddress(a);
}
export function getAddress(): string | null {
  return address;
}
export function clearAddress(): void {
  address = null;
  writePersistedAddress(null);
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
  address = null;
  sessionToken = null;
  writePersistedAddress(null);
}

// Client-side WebCrypto helpers for envelope encryption (AUTH.md §3, §5).
//
// All primitives use the Web Crypto API directly. Keys are non-extractable
// where possible. The only key the caller will ever hold extractable bytes
// for is the random DEK (generated as raw bytes so we can wrap it).

import { utf8ToBuffer } from "./encoding";

const KEK_INFO = utf8ToBuffer("wallet-v1-kek");

// ─── AES-GCM ──────────────────────────────────────────────────────────────

export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: ArrayBuffer | Uint8Array,
): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data: BufferSource =
    plaintext instanceof Uint8Array ? toArrayBufferView(plaintext) : plaintext;
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  return { ciphertext, iv: iv.buffer.slice(0) };
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  ciphertext: ArrayBuffer,
  iv: ArrayBuffer,
): Promise<ArrayBuffer> {
  return await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    ciphertext,
  );
}

// ─── DEK generation ──────────────────────────────────────────────────────
// We need the DEK to be extractable so we can re-wrap it under a new KEK
// when adding passkeys. Generate raw bytes, import as AES-GCM.

export function generateDekBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function importDekBytes(
  dekBytes: Uint8Array,
  extractable: boolean,
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBufferView(dekBytes),
    { name: "AES-GCM" },
    extractable,
    ["encrypt", "decrypt"],
  );
}

// ─── KEK derivation: HKDF over the PRF output ────────────────────────────

export async function deriveKekFromPrfOutput(
  prfOutput: ArrayBuffer,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    "HKDF",
    /* extractable */ false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new Uint8Array(KEK_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

// ─── Best-effort key material zero-out ───────────────────────────────────
// JS doesn't expose direct memory wiping; this is defence in depth.

export function zeroBytes(...arrs: Array<Uint8Array | undefined>): void {
  for (const a of arrs) {
    if (!a) continue;
    a.fill(0);
  }
}

// TS6 narrows `Uint8Array<ArrayBufferLike>` away from `BufferSource`. Copy
// into a fresh ArrayBuffer-backed Uint8Array so the WebCrypto types accept it.
function toArrayBufferView(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

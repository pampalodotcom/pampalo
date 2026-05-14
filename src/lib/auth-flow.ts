// High-level WebAuthn / envelope-encryption flows:
//
// - registerNewWallet: AUTH.md §6.1 (account creation + first passkey).
//   Returns the freshly generated mnemonic so the caller can show the
//   confirmation UX. Once the user confirms, call `finalizeNewWallet` to
//   derive + persist the address.
// - signIn: AUTH.md §6.2 (sign-in). Returns the derived address.
// - signOut: AUTH.md §6.4. Hits the /auth/signout HTTP route.
// - bootstrapFromCookie: AUTH.md §6.5 / §6.7 — used on page load.

import { Wallet } from "ethers";
import type { HDNodeWallet } from "ethers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveKekFromPrfOutput,
  generateDekBytes,
  importDekBytes,
  zeroBytes,
} from "./crypto";
import { base64UrlToBuffer, bufferToBase64Url, utf8ToBuffer, bufferToUtf8 } from "./encoding";
import { postJson } from "./http";
import {
  clearAll,
  getBlob,
  setAddress,
  setBlob,
  setSessionToken,
} from "./keystore";
import type { EncryptedBlob } from "./keystore";
import {
  extractPrfFirst,
  getGlobalPrfSalt,
  prfEnabledOnRegistration,
  runGetForPrf,
  runRegistrationCeremony,
} from "./passkey";

// ─── Wire types matching convex/http.ts ──────────────────────────────────

type RegStartRes = {
  userIdBytes: string;
  challenge: string;
  rpId: string;
  rpName: string;
};
type RegCompleteRes = { sessionToken: string; expiresAt: number };
type AuthStartRes = { challenge: string; rpId: string };
type AuthCompleteRes = { sessionToken: string; expiresAt: number };
type BootstrapRes = {
  sessionToken: string;
  sessionExpiresAt: number;
  wallet: { mnemonicCiphertext: string; mnemonicIv: string };
  credentials: Array<{
    credentialId: string;
    prfSalt: string;
    wrappedDek: string;
    wrappedDekIv: string;
    label: string;
  }>;
};

// ─── Registration ────────────────────────────────────────────────────────

export type NewWalletDraft = {
  mnemonic: string;
  address: string;
  sessionToken: string;
};

export async function registerNewWallet(_unusedLabel?: string): Promise<NewWalletDraft> {
  // 1. Generate wallet first so we can use the short address as the
  //    WebAuthn user.name — that's what shows up in the OS keychain picker
  //    and lets multiple wallets on the same RP be told apart.
  const dekBytes = generateDekBytes();
  const wallet = Wallet.createRandom();
  const mnemonic = wallet.mnemonic?.phrase;
  if (!mnemonic) throw new Error("ethers did not return a mnemonic");
  const address = wallet.address;
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const passkeyDisplayName = `Pampalo · ${short}`;

  // 2. Server start (records the random userIdBytes + challenge).
  const start = await postJson<{ displayName: string }, RegStartRes>(
    "/auth/registration/start",
    { displayName: passkeyDisplayName },
  );

  // 3. Browser create() with PRF.
  const attestation = await runRegistrationCeremony(start, passkeyDisplayName);
  if (!prfEnabledOnRegistration(attestation)) {
    throw new Error(
      "This authenticator did not enable the PRF extension — Pampalo requires it.",
    );
  }

  // 4. Browser get() to actually derive PRF output.
  const fakeChallengeForPrf = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const { prfOutput } = await runGetForPrf({
    challenge: fakeChallengeForPrf,
    rpId: start.rpId,
    allowCredentialId: attestation.id,
  });

  let kek: CryptoKey | null = null;
  let dekKey: CryptoKey | null = null;
  let mnemonicCiphertext: ArrayBuffer | null = null;
  let mnemonicIv: ArrayBuffer | null = null;
  let wrappedDek: ArrayBuffer | null = null;
  let wrappedDekIv: ArrayBuffer | null = null;
  let saltCopy: Uint8Array | null = null;

  try {
    kek = await deriveKekFromPrfOutput(prfOutput);
    dekKey = await importDekBytes(dekBytes, false);

    const enc = await aesGcmEncrypt(dekKey, utf8ToBuffer(mnemonic));
    mnemonicCiphertext = enc.ciphertext;
    mnemonicIv = enc.iv;

    const wrapped = await aesGcmEncrypt(kek, dekBytes);
    wrappedDek = wrapped.ciphertext;
    wrappedDekIv = wrapped.iv;

    // 5. Server complete.
    const saltAB = await getGlobalPrfSalt();
    saltCopy = new Uint8Array(saltAB.byteLength);
    saltCopy.set(new Uint8Array(saltAB));

    const completeBody = {
      userIdBytes: start.userIdBytes,
      attestation,
      walletPayload: {
        mnemonicCiphertext: bufferToBase64Url(mnemonicCiphertext),
        mnemonicIv: bufferToBase64Url(mnemonicIv),
        wrappedDek: bufferToBase64Url(wrappedDek),
        wrappedDekIv: bufferToBase64Url(wrappedDekIv),
        prfSalt: bufferToBase64Url(saltCopy),
        label: defaultPasskeyLabel(),
      },
    };
    const complete = await postJson<typeof completeBody, RegCompleteRes>(
      "/auth/registration/complete",
      completeBody,
    );

    // 6. Address is already derived above; surface it back to the caller.
    return {
      mnemonic,
      address,
      sessionToken: complete.sessionToken,
    };
  } finally {
    // Best-effort wipe of in-memory key material. References to CryptoKey are
    // dropped; raw byte arrays are zeroed.
    zeroBytes(dekBytes, saltCopy ?? undefined);
    kek = null;
    dekKey = null;
    mnemonicCiphertext = null;
    mnemonicIv = null;
    wrappedDek = null;
    wrappedDekIv = null;
    void kek;
    void dekKey;
    void mnemonicCiphertext;
    void mnemonicIv;
    void wrappedDek;
    void wrappedDekIv;
  }
}

export function finalizeNewWallet(draft: NewWalletDraft): void {
  // Mnemonic is intentionally NOT cached. The blob is repopulated via
  // /auth/bootstrap on the next page navigation.
  setSessionToken(draft.sessionToken);
  setAddress(draft.address);
}

// ─── Sign in ─────────────────────────────────────────────────────────────

export async function signInWithExistingPasskey(): Promise<string> {
  // 1. Server start.
  const start = await postJson<Record<string, never>, AuthStartRes>(
    "/auth/authentication/start",
    {},
  );

  // 2. Browser get() with PRF, no allowCredentials → discoverable picker.
  const { assertion, prfOutput } = await runGetForPrf({
    challenge: start.challenge,
    rpId: start.rpId,
  });

  // 3. Server verify.
  const complete = await postJson<{ assertion: typeof assertion }, AuthCompleteRes>(
    "/auth/authentication/complete",
    { assertion },
  );

  // 4. Pull the encrypted blob and decrypt.
  const address = await unlockWith(prfOutput, complete.sessionToken);
  return address;
}

// ─── Conditional-UI handler ──────────────────────────────────────────────
// When a conditional-mediation get() resolves on its own (autofill/sheet),
// we still need to verify and unlock. Same shape as signInWithExistingPasskey
// but the assertion came from the conditional ceremony.

export async function completeConditionalSignIn(
  assertion: AuthenticationResponseJSON,
): Promise<string> {
  const prfOutput = extractPrfFirst(assertion);
  if (!prfOutput) {
    throw new Error("Conditional ceremony returned no PRF output.");
  }
  const complete = await postJson<{ assertion: typeof assertion }, AuthCompleteRes>(
    "/auth/authentication/complete",
    { assertion },
  );
  return await unlockWith(prfOutput, complete.sessionToken);
}

// ─── Re-auth (unlock-only, no new session) ───────────────────────────────
// After a hard refresh, the bootstrap call repopulates the encrypted blob
// in the keystore but the mnemonic / address are gone. This runs a passkey
// ceremony purely to derive PRF and decrypt — no server round-trip for
// auth, since the cookie is still valid.

export async function reAuthenticate(): Promise<string> {
  const blob = getBlob();
  if (!blob) {
    // Blob hasn't been bootstrapped yet — fall back to full sign-in.
    return await signInWithExistingPasskey();
  }
  const cred = blob.credentials[0];

  // Local-only challenge: the PRF derivation runs entirely in the
  // authenticator + browser; the server never sees this assertion.
  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const credentialIdB64 = bufferToBase64Url(cred.credentialId);

  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: rpIdHint(),
    allowCredentialId: credentialIdB64,
  });

  const kek = await deriveKekFromPrfOutput(prfOutput);
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    blob.mnemonicCiphertext,
    blob.mnemonicIv,
  );
  const mnemonic = bufferToUtf8(mnemonicBuf);

  let wallet: HDNodeWallet | null = null;
  try {
    wallet = Wallet.fromPhrase(mnemonic);
    const address = wallet.address;
    setAddress(address);
    return address;
  } finally {
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
    wallet = null;
  }
}

// rpId for the get() ceremony. We don't have the value from the server in
// the re-auth path; falls back to the current hostname which is correct
// for both `localhost` and prod domains.
function rpIdHint(): string {
  if (typeof window === "undefined") return "localhost";
  return window.location.hostname;
}

// ─── Sign out ────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  try {
    await postJson<Record<string, never>, { ok: true }>("/auth/signout", {});
  } finally {
    clearAll();
  }
}

// ─── Bootstrap from cookie (page load) ───────────────────────────────────
// Returns null if no valid session. On success, populates the in-memory
// keystore (without unlocking) and returns the session token. The address
// is NOT set yet; that happens on the next §6.6 unlock or via signIn.

export async function bootstrapFromCookie(): Promise<{
  sessionToken: string;
  blob: EncryptedBlob;
} | null> {
  try {
    const res = await postJson<Record<string, never>, BootstrapRes>(
      "/auth/bootstrap",
      {},
    );
    const blob: EncryptedBlob = {
      mnemonicCiphertext: base64UrlToBuffer(res.wallet.mnemonicCiphertext),
      mnemonicIv: base64UrlToBuffer(res.wallet.mnemonicIv),
      credentials: res.credentials.map((c) => ({
        credentialId: base64UrlToBuffer(c.credentialId),
        prfSalt: base64UrlToBuffer(c.prfSalt),
        wrappedDek: base64UrlToBuffer(c.wrappedDek),
        wrappedDekIv: base64UrlToBuffer(c.wrappedDekIv),
        label: c.label,
      })),
    };
    setBlob(blob);
    setSessionToken(res.sessionToken);
    return { sessionToken: res.sessionToken, blob };
  } catch (e) {
    if (
      e instanceof Error &&
      (e as Error & { status?: number }).status === 401
    ) {
      return null;
    }
    throw e;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

async function unlockWith(
  prfOutput: ArrayBuffer,
  sessionToken: string,
): Promise<string> {
  // Refetch the encrypted blob via /auth/bootstrap (cookie now valid).
  const boot = await bootstrapFromCookie();
  if (!boot) throw new Error("Server didn't accept the freshly issued cookie");

  const cred = boot.blob.credentials[0];

  const kek = await deriveKekFromPrfOutput(prfOutput);
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    boot.blob.mnemonicCiphertext,
    boot.blob.mnemonicIv,
  );
  const mnemonic = bufferToUtf8(mnemonicBuf);

  let wallet: HDNodeWallet | null = null;
  try {
    wallet = Wallet.fromPhrase(mnemonic);
    const address = wallet.address;
    setAddress(address);
    setSessionToken(sessionToken);
    return address;
  } finally {
    // Best-effort scrub.
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
    wallet = null;
  }
}

function defaultPasskeyLabel(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}

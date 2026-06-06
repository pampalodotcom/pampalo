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
import { deriveAllAddresses } from "./derive-addresses";
import type { DerivedAddresses } from "./derive-addresses";
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  utf8ToBuffer,
  bufferToUtf8,
} from "./encoding";
import { postJson } from "./http";
import {
  clearAll,
  getBlob,
  getRpId,
  getSessionToken,
  setAddresses,
  setBlob,
  setRpId,
  setSessionToken,
} from "./keystore";
import type { EncryptedBlob } from "./keystore";
import {
  extractPrfFirst,
  prfEnabledOnRegistration,
  runGetForPrf,
  runRegistrationCeremony,
} from "./passkey";
import { PrfNotSupportedError, UnknownCredentialError } from "./auth-errors";
import { clearPrefsMemoryForSignOut } from "./preferences";
import { syncOnSignInComplete, syncOnTxSign } from "./preferences-sync";
import { syncShieldNotesOnSignIn } from "./sync-shield-notes";
import { Timing } from "./timing";

// ─── Typed errors for compatibility failures ─────────────────────────────
// Defined in ./auth-errors so non-auth modules (preferences-sync) can
// throw them without a circular import. Re-exported here for back-compat
// with existing route-level callers.

export { PrfNotSupportedError, UnknownCredentialError } from "./auth-errors";

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
  rpId: string;
  wallet: {
    mnemonicCiphertext: string;
    mnemonicIv: string;
  };
  credentials: Array<{
    credentialId: string;
    wrappedDek: string;
    wrappedDekIv: string;
    transports?: ReadonlyArray<string>;
  }>;
};

// ─── Registration ────────────────────────────────────────────────────────

export type NewWalletDraft = {
  mnemonic: string;
  addresses: DerivedAddresses;
  sessionToken: string;
};

export async function registerNewWallet(): Promise<NewWalletDraft> {
  return await registerWalletInternal({ source: "fresh" });
}

// Recover account — the v1 path for a user who has a recovery phrase
// but no enrolled passkey on this device. Mechanically the same as
// `registerNewWallet`: register a new passkey, encrypt the mnemonic
// under its PRF-derived KEK, insert a fresh wallet row. The only diffs
// from registration are (a) the mnemonic is supplied by the user
// rather than generated, and (b) the WebAuthn displayName is
// `Pampalo (Recovered)` so the OS keychain can distinguish recovered
// passkeys from originals in the picker. See ADR 0003.
export async function recoverAccount(mnemonic: string): Promise<SignInOutcome> {
  const draft = await registerWalletInternal({ source: "recovered", mnemonic });
  // Registration has a mnemonic-reveal interstitial, after which the
  // caller invokes `finalizeNewWallet` to persist sessionToken +
  // addresses to the keystore. Recovery has no such interstitial —
  // the user already has the phrase by definition — so we inline the
  // finalization here. Without this, refreshAddress() reads null from
  // the keystore, auth state stays `anonymous`, and /wallet either
  // bounces back to / or shows the "Unlock with passkey" prompt.
  setSessionToken(draft.sessionToken);
  setAddresses(draft.addresses);
  return { addresses: draft.addresses, sessionToken: draft.sessionToken };
}

type RegisterSource =
  | { source: "fresh" }
  | { source: "recovered"; mnemonic: string };

async function registerWalletInternal(
  opts: RegisterSource,
): Promise<NewWalletDraft> {
  // 1. Resolve the mnemonic. Either freshly generated (registration)
  //    or supplied by the user (recovery). Labelling diverges so the
  //    OS keychain can disambiguate the two passkeys when both end up
  //    in the same iCloud Keychain / Google Password Manager.
  const dekBytes = generateDekBytes();
  const wallet: HDNodeWallet =
    opts.source === "recovered"
      ? Wallet.fromPhrase(opts.mnemonic)
      : Wallet.createRandom();
  const mnemonic = wallet.mnemonic?.phrase;
  if (!mnemonic) throw new Error("ethers did not return a mnemonic");
  // Account creation: derive the full set (path-0 triple + the isolated
  // slot-420 envelope) so the cached addresses cover both Base Sepolia
  // and mainnet-style deployments without a follow-up PRF.
  const addresses = deriveAllAddresses(mnemonic);
  const passkeyDisplayName =
    opts.source === "recovered" ? "Pampalo (Recovered)" : "Pampalo";

  // 2. Server start (records the random userIdBytes + challenge).
  const start = await postJson<Record<string, never>, RegStartRes>(
    "/auth/registration/start",
    {},
  );

  // 3. Browser create(). We don't gate on prf.enabled here — iOS Safari +
  //    1Password routinely signal enabled:false / undefined on create
  //    even when the credential will happily produce PRF output on a
  //    subsequent get(). We log the value for diagnostics but always
  //    proceed to the get() and let *its* result decide.
  const attestation = await runRegistrationCeremony(start, passkeyDisplayName);
  console.log(
    "[pampalo:auth] register: create() prf.enabled =",
    prfEnabledOnRegistration(attestation),
  );

  // 4. Browser get() to actually derive PRF output. This is the
  //    authoritative capability check. PRF-less providers are rejected
  //    here — there is no passphrase fallback. See ADR 0002.
  const fakeChallengeForPrf = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const { prfOutput } = await runGetForPrf({
    challenge: fakeChallengeForPrf,
    rpId: start.rpId,
    allowCredentialId: attestation.id,
  });
  console.log(
    "[pampalo:auth] register: get() prfOutput =",
    prfOutput ? "present" : "null",
  );
  if (!prfOutput) {
    throw new PrfNotSupportedError();
  }

  let kek: CryptoKey | null = null;
  let dekKey: CryptoKey | null = null;
  let mnemonicCiphertext: ArrayBuffer | null = null;
  let mnemonicIv: ArrayBuffer | null = null;
  let wrappedDek: ArrayBuffer | null = null;
  let wrappedDekIv: ArrayBuffer | null = null;

  try {
    kek = await deriveKekFromPrfOutput(prfOutput);
    dekKey = await importDekBytes(dekBytes, false);

    const enc = await aesGcmEncrypt(dekKey, utf8ToBuffer(mnemonic));
    mnemonicCiphertext = enc.ciphertext;
    mnemonicIv = enc.iv;

    const wrapped = await aesGcmEncrypt(kek, dekBytes);
    wrappedDek = wrapped.ciphertext;
    wrappedDekIv = wrapped.iv;

    const completeBody = {
      userIdBytes: start.userIdBytes,
      attestation,
      walletPayload: {
        mnemonicCiphertext: bufferToBase64Url(mnemonicCiphertext),
        mnemonicIv: bufferToBase64Url(mnemonicIv),
        wrappedDek: bufferToBase64Url(wrappedDek),
        wrappedDekIv: bufferToBase64Url(wrappedDekIv),
      },
    };
    const complete = await postJson<typeof completeBody, RegCompleteRes>(
      "/auth/registration/complete",
      completeBody,
    );

    return {
      mnemonic,
      addresses,
      sessionToken: complete.sessionToken,
    };
  } finally {
    zeroBytes(dekBytes);
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
  setAddresses(draft.addresses);
}

// ─── Sign in ─────────────────────────────────────────────────────────────

export type SignInOutcome = {
  addresses: DerivedAddresses;
  sessionToken: string;
};

export async function signInWithExistingPasskey(): Promise<SignInOutcome> {
  const t = new Timing("sign-in");
  // 1. Server start.
  console.log("→ POST /auth/authentication/start");
  const start = await postJson<Record<string, never>, AuthStartRes>(
    "/auth/authentication/start",
    {},
  );
  console.log("← /auth/authentication/start");

  // 2. Browser get() with PRF, no allowCredentials → discoverable picker.
  // This is the user-interaction step — Face ID / Touch ID / passkey picker.
  console.log("→ navigator.credentials.get() (PRF)");
  const { assertion, prfOutput } = await runGetForPrf({
    challenge: start.challenge,
    rpId: start.rpId,
  });
  console.log("← navigator.credentials.get()");

  // 3. Server verify.
  console.log("→ POST /auth/authentication/complete");
  let complete: AuthCompleteRes;
  try {
    complete = await postJson<{ assertion: typeof assertion }, AuthCompleteRes>(
      "/auth/authentication/complete",
      { assertion },
    );
  } catch (e) {
    if (e instanceof Error && /unknown credential/i.test(e.message)) {
      throw new UnknownCredentialError();
    }
    throw e;
  }
  console.log("← /auth/authentication/complete");

  // 4. Bootstrap to discover protection scheme, then branch.
  const outcome = await unlockAfterAssertion(
    prfOutput,
    complete.sessionToken,
    t,
  );
  t.finish();
  return outcome;
}

// ─── Conditional-UI handler ──────────────────────────────────────────────
// When a conditional-mediation get() resolves on its own (autofill/sheet),
// we still need to verify and unlock. Same shape as signInWithExistingPasskey
// but the assertion came from the conditional ceremony.

export async function completeConditionalSignIn(
  assertion: AuthenticationResponseJSON,
): Promise<SignInOutcome> {
  const prfOutput = extractPrfFirst(assertion);
  let complete: AuthCompleteRes;
  try {
    complete = await postJson<{ assertion: typeof assertion }, AuthCompleteRes>(
      "/auth/authentication/complete",
      { assertion },
    );
  } catch (e) {
    if (e instanceof Error && /unknown credential/i.test(e.message)) {
      throw new UnknownCredentialError();
    }
    throw e;
  }
  return await unlockAfterAssertion(prfOutput, complete.sessionToken);
}

// ─── Re-auth (unlock-only, no new session) ───────────────────────────────
// After a hard refresh, the bootstrap call repopulates the encrypted blob
// in the keystore but the mnemonic / address are gone. This runs a passkey
// ceremony purely to derive PRF and decrypt — no server round-trip for
// auth, since the cookie is still valid.

export type ReAuthOutcome = { addresses: DerivedAddresses };

export async function reAuthenticate(): Promise<ReAuthOutcome> {
  const t = new Timing("re-auth");
  const blob = getBlob();
  if (!blob) {
    // Blob hasn't been bootstrapped yet — fall back to full sign-in.
    console.log("no blob → fallback to full sign-in");
    t.finish("fallback");
    const outcome = await signInWithExistingPasskey();
    return { addresses: outcome.addresses };
  }

  const cred = blob.credentials[0];

  // Local-only challenge: the PRF derivation runs entirely in the
  // authenticator + browser; the server never sees this assertion.
  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  // Scope the get() to the credential the user signed in with so the
  // browser prompts that exact platform passkey rather than falling back
  // to the cross-device QR sheet. rpId comes from the bootstrap response
  // (set during /auth/bootstrap), not window.location.hostname — the
  // latter breaks on apex-vs-www origins.
  console.log("→ navigator.credentials.get() (PRF, local challenge)");
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: getRpId() ?? rpIdHint(),
    allowCredentialId: bufferToBase64Url(cred.credentialId),
    allowCredentialTransports: cred.transports,
  });
  console.log("← navigator.credentials.get()");
  if (!prfOutput) {
    throw new PrfNotSupportedError();
  }

  console.log("HKDF: derive KEK from PRF output");
  const kek = await deriveKekFromPrfOutput(prfOutput);
  console.log("AES-GCM: unwrap DEK");
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);
  console.log("AES-GCM: decrypt mnemonic");
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    blob.mnemonicCiphertext,
    blob.mnemonicIv,
  );
  const mnemonic = bufferToUtf8(mnemonicBuf);
  console.log("mnemonic decoded");

  let wallet: HDNodeWallet | null = null;
  try {
    wallet = Wallet.fromPhrase(mnemonic);
    console.log("ethers.Wallet.fromPhrase()");
    // Full set (path-0 triple + slot-420 isolated envelope) so the
    // cached addresses cover both Base Sepolia (shared envelope) and
    // mainnet-style deployments (isolated envelope).
    const addresses = deriveAllAddresses(mnemonic);
    console.log(
      "deriveAllAddresses (EVM + envelope + envelopeIsolated + poseidon)",
    );
    setAddresses(addresses);
    console.log("keystore + localStorage updated");
    // Trigger (a): sync encrypted preferences while DEK is briefly alive.
    // The reAuthenticate path doesn't have a fresh sessionToken, but the
    // existing one stored in the keystore is still valid.
    const sessionToken = getSessionToken();
    if (sessionToken) {
      await syncOnSignInComplete(dekKey, sessionToken);
    }
    // Trigger (a'): cross-device shield-note hydration. Uses the
    // wallet that's already in scope — no extra PRF prompt. Failures
    // are swallowed inside the sync module.
    await syncShieldNotesOnSignIn(wallet.privateKey, addresses.evm);
    t.finish();
    return { addresses };
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

// ─── Export recovery phrase ──────────────────────────────────────────────
// Runs a passkey ceremony to derive PRF and decrypt the mnemonic, returning
// the plaintext for one-time display. Caller is responsible for clearing
// it from React state as soon as the user dismisses the UI.

export async function exportMnemonic(): Promise<string> {
  let blob = getBlob();
  if (!blob) {
    const boot = await bootstrapFromCookie();
    if (!boot) throw new Error("Session expired — please sign in again.");
    blob = boot.blob;
  }
  const cred = blob.credentials[0];

  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  // Scope the get() to the credential the user signed in with so the
  // browser prompts that exact platform passkey rather than falling back
  // to the cross-device QR sheet. rpId comes from the bootstrap response.
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: getRpId() ?? rpIdHint(),
    allowCredentialId: bufferToBase64Url(cred.credentialId),
    allowCredentialTransports: cred.transports,
  });
  if (!prfOutput) throw new PrfNotSupportedError();

  const kek = await deriveKekFromPrfOutput(prfOutput);
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    blob.mnemonicCiphertext,
    blob.mnemonicIv,
  );
  const mnemonic = bufferToUtf8(mnemonicBuf);

  // Trigger (b): opportunistic preferences push while DEK is briefly
  // alive. CLIENT_SIDE_FIRST.md frames this as the tx-signing piggyback;
  // tx-signing is "coming soon", so exportMnemonic is the only §6.6-style
  // ceremony today. When tx-signing lands, the same call shape applies.
  const sessionToken = getSessionToken();
  if (sessionToken) {
    await syncOnTxSign(dekKey, sessionToken);
  }

  // Scrub the intermediate key material. The mnemonic itself is the
  // return value — the caller is responsible for dropping its reference.
  new Uint8Array(dekBytes).fill(0);
  new Uint8Array(mnemonicBuf).fill(0);

  return mnemonic;
}

// ─── Export wallet private key (one-shot) ────────────────────────────────
// Mirrors `exportMnemonic` but returns the m/44'/60'/0'/0/0 private key
// (0x + 64 hex) instead of the 12-word phrase. Used by transfer-prep so
// it can populate `owner_secret` on input notes for proof generation.
// Caller drops the key as soon as the proof is built; we don't keep a
// module-scoped copy.

export async function getWalletPrivateKeyOnce(): Promise<string> {
  const mnemonic = await exportMnemonic();
  try {
    const wallet = Wallet.fromPhrase(mnemonic);
    return wallet.privateKey;
  } finally {
    // exportMnemonic returns a string we can't zero in-place; the best
    // we can do is drop the reference and let GC collect.
  }
}

// ─── One-PRF wallet access for compound flows ───────────────────────────
// Some flows need BOTH the wallet's private key (e.g. transfer-prep
// populating `owner_secret` on input notes) AND `wallet.signTransaction`
// for the broadcast. Doing those separately via getWalletPrivateKeyOnce
// + signTransactionWithPasskey costs two passkey prompts back-to-back.
// `withUnlockedWallet` runs one PRF ceremony and yields the unlocked
// `Wallet` to a callback for the full compound operation.
//
// Lifecycle:
//   1. PRF + unwrap DEK + decrypt mnemonic (single ceremony)
//   2. wallet = Wallet.fromPhrase(mnemonic)
//   3. await fn(wallet) — caller does whatever needs the unlocked wallet
//   4. Opportunistic preferences sync via the dek + sessionToken (matches
//      signTransactionWithPasskey's "trigger (b)")
//   5. Zero dekBytes + mnemonicBuf in finally

export async function withUnlockedWallet<T>(
  fn: (wallet: HDNodeWallet) => Promise<T>,
): Promise<T> {
  let blob = getBlob();
  if (!blob) {
    const boot = await bootstrapFromCookie();
    if (!boot) throw new Error("Session expired — please sign in again.");
    blob = boot.blob;
  }
  const cred = blob.credentials[0];

  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: getRpId() ?? rpIdHint(),
    allowCredentialId: bufferToBase64Url(cred.credentialId),
    allowCredentialTransports: cred.transports,
  });
  if (!prfOutput) throw new PrfNotSupportedError();

  const kek = await deriveKekFromPrfOutput(prfOutput);
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    blob.mnemonicCiphertext,
    blob.mnemonicIv,
  );
  const mnemonic = bufferToUtf8(mnemonicBuf);

  try {
    const wallet = Wallet.fromPhrase(mnemonic);
    // Refresh the cached addresses opportunistically — the path-0 triple
    // doesn't change, but this populates `envelopeIsolated` (slot 420)
    // for existing users who signed in before that field landed. Cheap
    // (one HD derivation) and the side effect is idempotent.
    setAddresses(deriveAllAddresses(mnemonic));
    const result = await fn(wallet);
    // Prefs sync piggyback — same trigger (b) as signTransactionWithPasskey.
    const sessionToken = getSessionToken();
    if (sessionToken) {
      await syncOnTxSign(dekKey, sessionToken);
    }
    // Notes sync piggyback. Fire-and-forget so the caller's `fn`
    // result returns immediately; the sync runs in the background
    // with a captured copy of address + privKey (scrubbed in
    // `finally` below doesn't reach them — they live in the spawned
    // promise's closure until it resolves, then GC).
    void syncShieldNotesOnSignIn(wallet.privateKey, wallet.address);
    return result;
  } finally {
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
  }
}

// ─── Sign Transaction ────────────────────────────────────────────────────
// Mirrors `exportMnemonic` but signs a raw transaction request instead of
// returning the mnemonic. The plaintext mnemonic never leaves this
// closure — caller only sees the hex-encoded signed tx string ready for
// `eth_sendRawTransaction`. Triggers the same opportunistic prefs sync
// because the DEK is briefly alive (CLIENT_SIDE_FIRST.md "tx-signing
// piggyback").

export type SignableTransactionRequest = {
  chainId: number;
  to: string;
  value?: string | bigint; // wei
  data?: string;
  nonce?: number;
  gasLimit?: string | bigint;
  // Legacy and 1559 fee fields. Only one set will be applied; if
  // maxFeePerGas/maxPriorityFeePerGas are provided ethers builds a type-2
  // transaction, otherwise it falls back to a legacy one.
  gasPrice?: string | bigint;
  maxFeePerGas?: string | bigint;
  maxPriorityFeePerGas?: string | bigint;
  type?: number;
};

export async function signTransactionWithPasskey(
  tx: SignableTransactionRequest,
): Promise<string> {
  let blob = getBlob();
  if (!blob) {
    const boot = await bootstrapFromCookie();
    if (!boot) throw new Error("Session expired — please sign in again.");
    blob = boot.blob;
  }
  const cred = blob.credentials[0];

  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: getRpId() ?? rpIdHint(),
    allowCredentialId: bufferToBase64Url(cred.credentialId),
    allowCredentialTransports: cred.transports,
  });
  if (!prfOutput) throw new PrfNotSupportedError();

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
    // Refresh cached addresses (populates `envelopeIsolated` for existing
    // users — see withUnlockedWallet for the same idempotent refresh).
    setAddresses(deriveAllAddresses(mnemonic));
    // ethers TransactionRequest accepts bigint OR decimal strings; passing
    // through directly means callers don't have to care about the diff.
    // 1559 vs legacy is mutually exclusive: if the caller supplied 1559
    // fields we drop the legacy gasPrice (and vice versa) so ethers
    // doesn't throw `received both gasPrice and maxFeePerGas`.
    const useEip1559 = tx.maxFeePerGas != null;
    const signed = await wallet.signTransaction({
      chainId: tx.chainId,
      to: tx.to,
      value: tx.value ?? 0n,
      data: tx.data ?? "0x",
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      gasPrice: useEip1559 ? undefined : tx.gasPrice,
      maxFeePerGas: useEip1559 ? tx.maxFeePerGas : undefined,
      maxPriorityFeePerGas: useEip1559 ? tx.maxPriorityFeePerGas : undefined,
      type: tx.type ?? (useEip1559 ? 2 : undefined),
    });
    // Trigger (b): tx-sign piggyback for encrypted-prefs sync.
    const sessionToken = getSessionToken();
    if (sessionToken) {
      await syncOnTxSign(dekKey, sessionToken);
    }
    // Trigger (b'): shielded-notes sync piggyback. Fire-and-forget so
    // the caller's signed tx returns immediately; the sync runs in the
    // background using a copy of the wallet's address + private key
    // that we capture before scrubbing. Errors are swallowed inside
    // syncShieldNotesOnSignIn.
    const addressForSync = wallet.address;
    const privKeyForSync = wallet.privateKey;
    void syncShieldNotesOnSignIn(privKeyForSync, addressForSync);
    return signed;
  } finally {
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
    wallet = null;
  }
}

// ─── Sign out ────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  try {
    await postJson<Record<string, never>, { ok: true }>("/auth/signout", {});
  } finally {
    clearAll();
    // Clear in-memory prefs only. The IDB record is intentionally NOT
    // wiped here: if the user toggled a setting this session but no PRF
    // ceremony fired (no tx, no explicit sync), the change is still dirty
    // in IDB and will push on the next sign-in. See CLIENT_SIDE_FIRST.md.
    clearPrefsMemoryForSignOut();
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
        wrappedDek: base64UrlToBuffer(c.wrappedDek),
        wrappedDekIv: base64UrlToBuffer(c.wrappedDekIv),
        transports: c.transports,
      })),
    };
    setBlob(blob);
    setSessionToken(res.sessionToken);
    setRpId(res.rpId);
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

async function unlockAfterAssertion(
  prfOutput: ArrayBuffer | null,
  sessionToken: string,
  parentTiming?: Timing,
): Promise<SignInOutcome> {
  const t = parentTiming ?? new Timing("unlock");

  console.log("→ POST /auth/bootstrap");
  const boot = await bootstrapFromCookie();
  if (!boot) throw new Error("Server didn't accept the freshly issued cookie");
  console.log("← /auth/bootstrap");

  setSessionToken(sessionToken);

  if (!prfOutput) {
    throw new PrfNotSupportedError();
  }
  const cred = boot.blob.credentials[0];

  console.log("HKDF: derive KEK from PRF output");
  const kek = await deriveKekFromPrfOutput(prfOutput);
  console.log("AES-GCM: unwrap DEK");
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);
  console.log("AES-GCM: decrypt mnemonic");
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    boot.blob.mnemonicCiphertext,
    boot.blob.mnemonicIv,
  );
  const mnemonic = bufferToUtf8(mnemonicBuf);
  console.log("mnemonic decoded");

  let wallet: HDNodeWallet | null = null;
  try {
    wallet = Wallet.fromPhrase(mnemonic);
    console.log("ethers.Wallet.fromPhrase()");
    // Full set (path-0 triple + slot-420 isolated envelope) so the
    // cached addresses cover both Base Sepolia (shared envelope) and
    // mainnet-style deployments (isolated envelope).
    const addresses = deriveAllAddresses(mnemonic);
    console.log(
      "deriveAllAddresses (EVM + envelope + envelopeIsolated + poseidon)",
    );
    setAddresses(addresses);
    console.log("keystore + localStorage updated");
    // Trigger (a): sync encrypted preferences while DEK is briefly alive.
    // See CLIENT_SIDE_FIRST.md. Failures are swallowed inside the sync
    // module — they must not abort sign-in.
    await syncOnSignInComplete(dekKey, sessionToken);
    await syncShieldNotesOnSignIn(wallet.privateKey, addresses.evm);
    if (!parentTiming) t.finish();
    return { addresses, sessionToken };
  } finally {
    // Best-effort scrub.
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
    wallet = null;
  }
}

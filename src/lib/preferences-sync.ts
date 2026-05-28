// Sync engine for the encrypted-preferences flow. See CLIENT_SIDE_FIRST.md.
//
// IndexedDB (preferences.ts) is the local source of truth. This module is
// the bridge to Convex: it encrypts the local prefs under the wallet DEK
// and pushes them, and decrypts the upstream ciphertext and merges it
// back. The DEK is never retained — every entry point requires it to be
// supplied by an active PRF ceremony.

import { api } from "../../convex/_generated/api";
import { getConvexClient } from "./convex-client";
import {
  aesGcmDecrypt,
  decryptJsonWithDek,
  deriveKekFromPrfOutput,
  encryptJsonWithDek,
  importDekBytes,
} from "./crypto";
import { bufferToBase64Url, base64UrlToBuffer } from "./encoding";
import { getBlob, getRpId, getSessionToken } from "./keystore";
import {
  applyPulledPrefs,
  getCurrentPrefsSnapshot,
  getLastSeenRevision,
  isDirty,
  markPushed,
  type Prefs,
} from "./preferences";
import { runGetForPrf } from "./passkey";
import { PrfNotSupportedError } from "./auth-errors";

// ─── Wire-format normalization ────────────────────────────────────────────
// Convex `v.bytes()` columns can surface as ArrayBuffer OR base64url string
// depending on runtime version. Coerce to a single shape before crypto.

function coerceToBuffer(value: ArrayBuffer | string): ArrayBuffer {
  if (typeof value === "string") return base64UrlToBuffer(value);
  return value;
}

// ─── Core operations (DEK already in caller's hands) ─────────────────────

export async function pullDuringCeremony(
  dek: CryptoKey,
  sessionToken: string,
): Promise<void> {
  // v1 conflict policy: if local has unsync'd changes, do NOT overwrite
  // with upstream. The subsequent push wins. See CLIENT_SIDE_FIRST.md.
  if (isDirty()) return;

  const convex = getConvexClient();
  if (!convex) return;

  const row = await convex.query(api.preferences.mutations.getEncryptedPreferences, {
    sessionToken,
  });
  if (!row) return;

  const lastSeen = getLastSeenRevision();
  if (lastSeen !== null && row.revision <= lastSeen) return;

  const prefs = await decryptJsonWithDek<Prefs>(
    dek,
    coerceToBuffer(row.ciphertext),
    coerceToBuffer(row.iv),
  );
  applyPulledPrefs(prefs, row.revision);
}

export async function pushDuringCeremony(
  dek: CryptoKey,
  sessionToken: string,
): Promise<void> {
  const convex = getConvexClient();
  if (!convex) return;

  const prefs = getCurrentPrefsSnapshot();
  const { ciphertext, iv } = await encryptJsonWithDek(dek, prefs);
  const { revision } = await convex.mutation(
    api.preferences.mutations.writeEncryptedPreferences,
    { sessionToken, ciphertext, iv },
  );
  markPushed(revision);
}

// ─── Trigger (a): sign-in ─────────────────────────────────────────────────

export async function syncOnSignInComplete(
  dek: CryptoKey,
  sessionToken: string,
): Promise<void> {
  try {
    await pullDuringCeremony(dek, sessionToken);
    if (isDirty()) {
      await pushDuringCeremony(dek, sessionToken);
    }
  } catch (e) {
    // Don't fail the sign-in flow if preference sync hits a hiccup; the
    // local IDB state still works, and the next ceremony will retry.
    console.warn("preferences-sync: signIn sync failed", e);
  }
}

// ─── Trigger (b): tx-signing piggyback ────────────────────────────────────

export async function syncOnTxSign(
  dek: CryptoKey,
  sessionToken: string,
): Promise<void> {
  if (!isDirty()) return;
  try {
    await pushDuringCeremony(dek, sessionToken);
  } catch (e) {
    console.warn("preferences-sync: tx-sign sync failed", e);
  }
}

// ─── Trigger (c): explicit user-tapped sync ──────────────────────────────
// Standalone §6.6-style PRF ceremony so it can run from anywhere (e.g. the
// BalanceCard sync indicator) without needing an in-flight signing op.

export async function syncExplicit(): Promise<void> {
  const blob = getBlob();
  const sessionToken = getSessionToken();
  if (!blob || !sessionToken) {
    throw new Error("Sign in required before manual sync");
  }
  const cred = blob.credentials[0];

  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  // Scope the get() to the credential the user already signed in with —
  // otherwise the browser shows the cross-device QR sheet ("use your
  // phone or tablet") instead of prompting the local platform passkey.
  // rpId comes from the bootstrap response, not window.location (which
  // is "www.pampalo.com" while registration used "pampalo.com").
  const fallbackRpId =
    typeof window !== "undefined" ? window.location.hostname : "localhost";
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: getRpId() ?? fallbackRpId,
    allowCredentialId: bufferToBase64Url(cred.credentialId),
    allowCredentialTransports: cred.transports,
  });
  if (!prfOutput) throw new PrfNotSupportedError();

  const kek = await deriveKekFromPrfOutput(prfOutput);
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv);
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false);

  try {
    // Force a pull even when dirty — explicit sync is the moment the user
    // signals "merge with upstream now." Push afterwards persists their
    // local view (LWW with current-device winning).
    const convex = getConvexClient();
    if (convex) {
      const row = await convex.query(api.preferences.mutations.getEncryptedPreferences, {
        sessionToken,
      });
      if (row) {
        const upstream = await decryptJsonWithDek<Prefs>(
          dekKey,
          coerceToBuffer(row.ciphertext),
          coerceToBuffer(row.iv),
        );
        applyPulledPrefs(
          isDirty() ? { ...upstream, ...getCurrentPrefsSnapshot() } : upstream,
          row.revision,
        );
      }
    }
    if (isDirty()) {
      await pushDuringCeremony(dekKey, sessionToken);
    }
  } finally {
    new Uint8Array(dekBytes).fill(0);
  }
}

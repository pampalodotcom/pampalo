// Shield-note cross-device hydration.
//
// The IDB notes facade (idb-notes.ts) is the wallet's source of truth
// for spendable balances. When a device has no local IDB record of a
// shield (because the user signed in on a new device, wiped IDB, or
// shielded from a sibling tab the optimistic write didn't reach) we
// rebuild the StoredNote from the Convex `shieldQueueEntries` row by
// ECIES-decrypting `encryptedPayload` with the user's envelope private
// key.
//
// Three entry points, mirroring `preferences-sync.ts`:
//
//   syncShieldNotesOnSignIn(privKey, evmAddress)
//     Called from auth-flow's sign-in/re-auth path while the wallet is
//     briefly alive. Best-effort; swallows errors so a failed sync
//     never blocks sign-in.
//
//   syncShieldNotesExplicit()
//     User-tapped (Sync button). Runs its own PRF ceremony, derives the
//     envelope private key, runs the same core, then scrubs.
//
//   syncShieldNotesWithPrivKey(privKey, evmAddress) — internal core.
//
// Cursor: per idb-sync-cursor.ts, we track `shieldQueueLastQueuedAt` —
// the highest `queuedAt` (ms) we've seen. Rows older than the cursor
// are skipped without a decrypt attempt. The cursor advances to the
// highest queuedAt we walked, regardless of decrypt success, so a
// permanently-undecryptable row doesn't pin us forever.

import { ethers, Wallet } from "ethers";
import { api } from "../../convex/_generated/api";
import { NoteDecryption } from "../../shared/classes/Note";
import {
  aesGcmDecrypt,
  deriveKekFromPrfOutput,
  importDekBytes,
} from "./crypto";
import { getConvexClient } from "./convex-client";
import { bufferToBase64Url, bufferToUtf8 } from "./encoding";
import { ETH_SENTINEL } from "./eth";
import {
  appendNote,
  findNote,
  type NoteState,
  type StoredNote,
} from "./idb-notes";
import { readSyncCursor, writeSyncCursor } from "./idb-sync-cursor";
import { getBlob, getRpId } from "./keystore";
import { runGetForPrf } from "./passkey";
import { PrfNotSupportedError } from "./auth-errors";

export type SyncShieldNotesResult = {
  /** Newly inserted into IDB. */
  added: number;
  /** Convex rows skipped because IDB already had the leaf. */
  skippedAlreadyPresent: number;
  /** Convex rows skipped because they're older than the cursor. */
  skippedByCursor: number;
  /** Rows where decrypt threw. Cursor advances past them. */
  decryptFailed: number;
  /** Rows whose Convex `deploymentId` is no longer in `enabledDeployments`. */
  unknownDeployment: number;
};

function emptyResult(): SyncShieldNotesResult {
  return {
    added: 0,
    skippedAlreadyPresent: 0,
    skippedByCursor: 0,
    decryptFailed: 0,
    unknownDeployment: 0,
  };
}

function convexStateToIdb(s: "queued" | "executed" | "cancelled" | "contested"): NoteState {
  return s === "executed" ? "spendable" : s;
}

// ─── Core ────────────────────────────────────────────────────────────────

export async function syncShieldNotesWithPrivKey(
  envelopePrivKey: string,
  evmAddress: string,
): Promise<SyncShieldNotesResult> {
  const convex = getConvexClient();
  if (!convex) return emptyResult();

  const [rows, deployments, tokens, cursor] = await Promise.all([
    convex.query(api.shieldQueue.store.byShielder, { shielder: evmAddress }),
    convex.query(api.shieldQueue.store.enabledDeployments, {}),
    convex.query(api.catalog.tokens.list, {}),
    readSyncCursor(),
  ]);

  // Index helpers.
  const chainByDeployment = new Map<
    string,
    { chainId: number; address: string }
  >();
  for (const d of deployments) {
    chainByDeployment.set(d._id, {
      chainId: d.chainId,
      address: d.pampaloAddress.toLowerCase(),
    });
  }
  const decimalsByChainAsset = new Map<string, number>();
  for (const t of tokens) {
    decimalsByChainAsset.set(
      `${t.chainId}:${t.address.toLowerCase()}`,
      t.decimals,
    );
  }

  const previousMax = cursor.shieldQueueLastQueuedAt ?? 0;
  let newMax = previousMax;
  const result = emptyResult();

  for (const row of rows) {
    if (row.queuedAt > newMax) newMax = row.queuedAt;

    if (row.queuedAt <= previousMax) {
      result.skippedByCursor += 1;
      continue;
    }

    const existing = await findNote(row.leafCommitment);
    if (existing) {
      result.skippedAlreadyPresent += 1;
      continue;
    }

    const dep = chainByDeployment.get(row.deploymentId);
    if (!dep) {
      result.unknownDeployment += 1;
      continue;
    }

    let plain: { secret: string; owner: string; asset_id: string; asset_amount: string };
    try {
      // Convex `v.bytes()` can surface as ArrayBuffer or base64url string
      // depending on runtime version. Normalize before hexlifying so the
      // decrypt path always sees `0x…`.
      const ciphertext = ciphertextToHex(row.encryptedPayload);
      plain = await NoteDecryption.decryptNoteData(
        ciphertext,
        envelopePrivKey,
      );
    } catch (e) {
      console.warn(
        "[sync-shield-notes] decrypt failed for leaf",
        row.leafCommitment,
        e,
      );
      result.decryptFailed += 1;
      continue;
    }

    const asset = row.asset.toLowerCase();
    const decimals =
      decimalsByChainAsset.get(`${dep.chainId}:${asset}`) ??
      (asset === ETH_SENTINEL ? 18 : 0);

    const note: StoredNote = {
      asset,
      assetDecimals: decimals,
      amount: plain.asset_amount,
      owner: "0x" + BigInt(plain.owner).toString(16).padStart(64, "0"),
      secret: "0x" + BigInt(plain.secret).toString(16).padStart(64, "0"),
      networkChainId: dep.chainId,
      deploymentAddress: dep.address,
      leafCommitment: row.leafCommitment,
      origin: "shield",
      state: convexStateToIdb(row.state),
      unlockTime: row.unlockTime,
      queuedTxHash: row.queuedTxHash,
    };
    await appendNote(note);
    result.added += 1;
  }

  if (newMax > previousMax) {
    await writeSyncCursor({ shieldQueueLastQueuedAt: newMax });
  }
  return result;
}

function ciphertextToHex(value: ArrayBuffer | string): string {
  if (typeof value === "string") {
    // `v.bytes()` over Convex websocket has been observed as both raw
    // base64url and as `0x…` hex. Detect by prefix.
    if (value.startsWith("0x")) return value;
    return ethers.hexlify(new Uint8Array(decodeB64Url(value)));
  }
  return ethers.hexlify(new Uint8Array(value));
}

function decodeB64Url(s: string): ArrayBuffer {
  // Match preferences-sync's `coerceToBuffer` semantics so both modules
  // agree on what wire-format normalization looks like.
  const padded = s + "===".slice((s.length + 3) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ─── On-sign-in hook ─────────────────────────────────────────────────────

export async function syncShieldNotesOnSignIn(
  envelopePrivKey: string,
  evmAddress: string,
): Promise<void> {
  try {
    await syncShieldNotesWithPrivKey(envelopePrivKey, evmAddress);
  } catch (e) {
    // Never block sign-in; the user can retry via the Sync button.
    console.warn("[sync-shield-notes] sign-in sync failed", e);
  }
}

// ─── Explicit user-tapped sync ───────────────────────────────────────────

export async function syncShieldNotesExplicit(): Promise<SyncShieldNotesResult> {
  const blob = getBlob();
  if (!blob) throw new Error("Session expired — please sign in again.");
  const cred = blob.credentials[0];

  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: getRpId() ?? window.location.hostname,
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
    return await syncShieldNotesWithPrivKey(wallet.privateKey, wallet.address);
  } finally {
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
  }
}

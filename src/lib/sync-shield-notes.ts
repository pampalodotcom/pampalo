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
import { poseidon2Hash } from "@zkpassport/poseidon2";
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
  listNotes,
  patchNoteByLeaf,
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
  /** Retired-deployment notes hydrated from the archive (ADR 0018). */
  archivedAdded: number;
};

function emptyResult(): SyncShieldNotesResult {
  return {
    added: 0,
    skippedAlreadyPresent: 0,
    skippedByCursor: 0,
    decryptFailed: 0,
    unknownDeployment: 0,
    archivedAdded: 0,
  };
}

function convexStateToIdb(
  s: "queued" | "executed" | "cancelled" | "contested",
): NoteState {
  return s === "executed" ? "spendable" : s;
}

// Archive rows store `state` as a free string; map tolerantly. Retired
// notes are read-only history, so the exact spend-state is cosmetic.
function archivedStateToIdb(s: string): NoteState {
  switch (s) {
    case "executed":
      return "spendable";
    case "queued":
    case "cancelled":
    case "contested":
      return s;
    default:
      return "spendable";
  }
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
    readSyncCursor(evmAddress),
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

    let plain: {
      secret: string;
      owner: string;
      asset_id: string;
      asset_amount: string;
    };
    try {
      // Convex `v.bytes()` can surface as ArrayBuffer or base64url string
      // depending on runtime version. Normalize before hexlifying so the
      // decrypt path always sees `0x…`.
      const ciphertext = ciphertextToHex(row.encryptedPayload);
      plain = await NoteDecryption.decryptNoteData(ciphertext, envelopePrivKey);
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
    await writeSyncCursor(evmAddress, { shieldQueueLastQueuedAt: newMax });
  }

  // ─── Receiver-side trial-decrypt (TRANSFERS.md §9.5) ────────────────
  // The byShielder path above covers self-shields. Cross-recipient
  // transfers don't carry the receiver's identity on-chain — the only
  // way to find them is to attempt ECIES decrypt on every NotePayload
  // emitted on each sponsoring chain and keep the ones that decrypt
  // with the user's envelope private key.
  for (const dep of deployments) {
    try {
      await scanTransferInNotesForChain(
        envelopePrivKey,
        dep.chainId,
        dep.pampaloAddress.toLowerCase(),
        tokens,
        result,
      );
    } catch (e) {
      console.warn(
        "[sync-shield-notes] transfer-in scan failed on chain",
        dep.chainId,
        e,
      );
    }
  }

  // ─── Retired-deployment archive (ADR 0018) ──────────────────────────
  // Hydrate read-only history for contracts we've redeployed away from,
  // so the wallet's History panel shows the same retired notes on a fresh
  // device. These land in IDB with their OLD deploymentAddress, so they
  // derive as retired (idb-notes.isNoteRetired) and never reach the spend
  // flow. Best-effort: a failure here must not poison live sync.
  try {
    await scanArchivedNotes(envelopePrivKey, evmAddress, tokens, result);
  } catch (e) {
    console.warn("[sync-shield-notes] archived scan failed", e);
  }

  return result;
}

// Pull retired self-shields (by shielder) + retired received notes (per
// archived chain) into IDB as read-only history. Mirrors the live paths
// but reads the archive tables and tags notes with the OLD deployment
// address. No cursor — relies on findNote() idempotency (archive sets are
// small / testnet-scale).
async function scanArchivedNotes(
  envelopePrivKey: string,
  evmAddress: string,
  tokens: ReadonlyArray<TokenForDecimals>,
  result: SyncShieldNotesResult,
): Promise<void> {
  const convex = getConvexClient();
  if (!convex) return;

  const [archivedShields, archivedDeployments] = await Promise.all([
    convex.query(api.shieldQueue.store.archivedByShielder, {
      shielder: evmAddress,
    }),
    convex.query(api.shieldQueue.store.listArchivedDeployments, {}),
  ]);

  const decimalsByChainAsset = new Map<string, number>();
  for (const t of tokens) {
    decimalsByChainAsset.set(
      `${t.chainId}:${t.address.toLowerCase()}`,
      t.decimals,
    );
  }

  // Retired self-shields.
  for (const row of archivedShields) {
    const existing = await findNote(row.leafCommitment);
    if (existing) {
      result.skippedAlreadyPresent += 1;
      continue;
    }
    let plain: {
      secret: string;
      owner: string;
      asset_id: string;
      asset_amount: string;
    };
    try {
      const ciphertext = ciphertextToHex(row.encryptedPayload);
      plain = await NoteDecryption.decryptNoteData(ciphertext, envelopePrivKey);
    } catch {
      result.decryptFailed += 1;
      continue;
    }
    const asset = row.asset.toLowerCase();
    const decimals =
      decimalsByChainAsset.get(`${row.chainId}:${asset}`) ??
      (asset === ETH_SENTINEL ? 18 : 0);
    await appendNote({
      asset,
      assetDecimals: decimals,
      amount: plain.asset_amount,
      owner: "0x" + BigInt(plain.owner).toString(16).padStart(64, "0"),
      secret: "0x" + BigInt(plain.secret).toString(16).padStart(64, "0"),
      networkChainId: row.chainId,
      deploymentAddress: row.archivedDeploymentAddress.toLowerCase(),
      leafCommitment: row.leafCommitment,
      origin: "shield",
      state: archivedStateToIdb(row.state),
      unlockTime: row.unlockTime,
      queuedTxHash: row.queuedTxHash,
    });
    result.archivedAdded += 1;
  }

  // Retired received notes — one trial-decrypt pass per archived chain.
  const archivedChains = new Set<number>(
    archivedDeployments.map((d) => d.chainId),
  );
  for (const chainId of archivedChains) {
    try {
      await scanArchivedTransferNotesForChain(
        envelopePrivKey,
        chainId,
        tokens,
        result,
      );
    } catch (e) {
      console.warn(
        "[sync-shield-notes] archived transfer-in scan failed on chain",
        chainId,
        e,
      );
    }
  }
}

async function scanArchivedTransferNotesForChain(
  envelopePrivKey: string,
  chainId: number,
  tokens: ReadonlyArray<TokenForDecimals>,
  result: SyncShieldNotesResult,
): Promise<void> {
  const convex = getConvexClient();
  if (!convex) return;

  const payloads = await convex.query(
    api.shieldQueue.store.archivedNotePayloadsForChain,
    { chainId },
  );

  const decimalsByAsset = new Map<string, number>();
  for (const t of tokens) {
    if (t.chainId !== chainId) continue;
    decimalsByAsset.set(t.address.toLowerCase(), t.decimals);
  }

  for (const row of payloads) {
    let plain: {
      secret: string;
      owner: string;
      asset_id: string;
      asset_amount: string;
    };
    try {
      const ciphertext = ciphertextToHex(row.encryptedPayload);
      plain = await NoteDecryption.decryptNoteData(ciphertext, envelopePrivKey);
    } catch {
      // Not ours — the common trial-decrypt miss. Quiet.
      continue;
    }

    const leafBig = poseidon2Hash([
      BigInt(plain.asset_id),
      BigInt(plain.asset_amount),
      BigInt(plain.owner),
      BigInt(plain.secret),
    ]);
    const leafCommitment = "0x" + leafBig.toString(16).padStart(64, "0");

    const existing = await findNote(leafCommitment);
    if (existing) {
      result.skippedAlreadyPresent += 1;
      continue;
    }

    const assetBig = BigInt(plain.asset_id);
    const assetLower =
      ("0x" + assetBig.toString(16).padStart(40, "0")).toLowerCase();
    const decimals =
      decimalsByAsset.get(assetLower) ?? (assetLower === ETH_SENTINEL ? 18 : 0);

    // Retired received note — no leafIndex (its tree is abandoned, never
    // spent). It derives as retired from the old deployment address.
    await appendNote({
      asset: assetLower,
      assetDecimals: decimals,
      amount: plain.asset_amount,
      owner: "0x" + BigInt(plain.owner).toString(16).padStart(64, "0"),
      secret: "0x" + BigInt(plain.secret).toString(16).padStart(64, "0"),
      networkChainId: chainId,
      deploymentAddress: row.archivedDeploymentAddress.toLowerCase(),
      leafCommitment,
      origin: "transferIn",
      state: "spendable",
    });
    result.archivedAdded += 1;
  }
}

type TokenForDecimals = {
  chainId: number;
  address: string;
  decimals: number;
};

async function scanTransferInNotesForChain(
  envelopePrivKey: string,
  chainId: number,
  pampaloAddress: string,
  tokens: ReadonlyArray<TokenForDecimals>,
  result: SyncShieldNotesResult,
): Promise<void> {
  const convex = getConvexClient();
  if (!convex) return;

  const [payloads, leaves] = await Promise.all([
    convex.query(api.shieldQueue.store.notePayloadsForChain, { chainId }),
    convex.query(api.shieldQueue.store.leavesForChain, { chainId }),
  ]);

  // (commitment → position) lookup so each successful decrypt resolves
  // to a leafIndex without an extra per-row query.
  const leafByCommitment = new Map<
    string,
    { epoch: number; leafIndex: number; insertedTxHash: string }
  >();
  for (const l of leaves) {
    leafByCommitment.set(l.leafCommitment.toLowerCase(), {
      epoch: l.epoch,
      leafIndex: l.leafIndex,
      insertedTxHash: l.insertedTxHash,
    });
  }

  // Backfill leafIndex / treeIndex on existing IDB notes that are
  // spendable but missing position info. The shield-side IDB writer
  // (useShieldQueueSync) only patches state + unlockTime + txHash —
  // the leaf position lives in the new pampaloLeaves table. Without
  // this backfill, notes shielded before the LeafInserted indexer
  // landed (or whose useShieldQueueSync ran before the leaf was
  // indexed) can't be spent in a transfer because transfer-prep
  // demands leafIndex. Cheap: a single Map lookup per note.
  const allNotes = await listNotes();
  for (const note of allNotes) {
    if (note.networkChainId !== chainId) continue;
    if (note.state !== "spendable") continue;
    if (note.leafIndex !== undefined) continue;
    const pos = leafByCommitment.get(note.leafCommitment.toLowerCase());
    if (!pos) continue;
    await patchNoteByLeaf(note.leafCommitment, {
      leafIndex: pos.leafIndex,
      treeIndex: pos.epoch,
    });
  }

  const decimalsByAsset = new Map<string, number>();
  for (const t of tokens) {
    if (t.chainId !== chainId) continue;
    decimalsByAsset.set(t.address.toLowerCase(), t.decimals);
  }

  for (const row of payloads) {
    let plain: {
      secret: string;
      owner: string;
      asset_id: string;
      asset_amount: string;
    };
    try {
      const ciphertext = ciphertextToHex(row.encryptedPayload);
      plain = await NoteDecryption.decryptNoteData(ciphertext, envelopePrivKey);
    } catch {
      // Decrypt failed → payload is for someone else. Quiet: this is
      // the common case in the trial-decrypt model.
      continue;
    }

    // Recompute the leaf commitment: poseidon2([asset_id, amount,
    // owner, secret]). Same layout as the circuits + shield-prep.
    const leafBig = poseidon2Hash([
      BigInt(plain.asset_id),
      BigInt(plain.asset_amount),
      BigInt(plain.owner),
      BigInt(plain.secret),
    ]);
    const leafCommitment = "0x" + leafBig.toString(16).padStart(64, "0");

    // Already in IDB? Skip — handles the shield-to-self case where
    // byShielder already populated, and replay idempotency in general.
    const existing = await findNote(leafCommitment);
    if (existing) {
      result.skippedAlreadyPresent += 1;
      continue;
    }

    const position = leafByCommitment.get(leafCommitment);
    if (!position) {
      // Decrypted, but the corresponding LeafInserted hasn't been
      // indexed yet. Wait for the next Sync — the leaf event lands
      // before / alongside NotePayload on chain, so this is usually
      // a same-tick cold-start race.
      continue;
    }

    const assetBig = BigInt(plain.asset_id);
    const asset = "0x" + assetBig.toString(16).padStart(40, "0");
    const assetLower = asset.toLowerCase();
    const decimals =
      decimalsByAsset.get(assetLower) ?? (assetLower === ETH_SENTINEL ? 18 : 0);

    await appendNote({
      asset: assetLower,
      assetDecimals: decimals,
      amount: plain.asset_amount,
      owner: "0x" + BigInt(plain.owner).toString(16).padStart(64, "0"),
      secret: "0x" + BigInt(plain.secret).toString(16).padStart(64, "0"),
      networkChainId: chainId,
      deploymentAddress: pampaloAddress,
      leafCommitment,
      treeIndex: position.epoch,
      leafIndex: position.leafIndex,
      origin: "transferIn",
      // Transfer outputs are spendable the moment they land in the
      // tree — no queue wait like shield. The corresponding
      // LeafInserted event has already fired (we just looked it up).
      state: "spendable",
      queuedTxHash: position.insertedTxHash,
    });
    result.added += 1;
  }
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

// ─── Lightweight leaf-index backfill (no PRF required) ───────────────────
//
// Every PoseidonMerkleTree.LeafInserted event is publicly indexed into
// `pampaloLeaves`; mapping a commitment to its position is just a map
// lookup. The shield-side IDB writer doesn't populate the position
// (it only sets state + unlockTime + queuedTxHash), which means
// freshly-spendable notes can't be spent in a transfer until either
// the user taps Sync OR this auto-backfill runs.
//
// Fast: one Convex query per affected chain, then a few patches in
// IDB. No envelope private key, no PRF, no decrypt. Safe to call on
// every wallet mount.
export async function backfillLeafIndices(): Promise<{
  patched: number;
}> {
  const convex = getConvexClient();
  if (!convex) return { patched: 0 };

  const allNotes = await listNotes();
  const chainsWithGaps = new Set<number>();
  for (const note of allNotes) {
    if (note.state === "spendable" && note.leafIndex === undefined) {
      chainsWithGaps.add(note.networkChainId);
    }
  }
  if (chainsWithGaps.size === 0) return { patched: 0 };

  let patched = 0;
  for (const chainId of chainsWithGaps) {
    const leaves = await convex.query(api.shieldQueue.store.leavesForChain, {
      chainId,
    });
    const leafByCommitment = new Map<
      string,
      { epoch: number; leafIndex: number }
    >();
    for (const l of leaves) {
      leafByCommitment.set(l.leafCommitment.toLowerCase(), {
        epoch: l.epoch,
        leafIndex: l.leafIndex,
      });
    }
    for (const note of allNotes) {
      if (note.networkChainId !== chainId) continue;
      if (note.state !== "spendable") continue;
      if (note.leafIndex !== undefined) continue;
      const pos = leafByCommitment.get(note.leafCommitment.toLowerCase());
      if (!pos) continue;
      await patchNoteByLeaf(note.leafCommitment, {
        leafIndex: pos.leafIndex,
        treeIndex: pos.epoch,
      });
      patched += 1;
    }
  }
  return { patched };
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

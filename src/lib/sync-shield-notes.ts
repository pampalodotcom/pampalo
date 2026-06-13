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
// Notes can be encrypted to EITHER envelope key — the shared path-0 key
// (Base Sepolia) or the isolated slot-420 key (mainnets, where the
// deployment sets separateDerivationKey: true). So every decrypt is a
// trial-decrypt across the full set from `deriveEnvelopePrivKeys`. A wallet
// that only tried path-0 silently dropped every mainnet note (the "private
// transfer never arrives" bug). The set is threaded as `envelopePrivKeys`.
//
// Three entry points, mirroring `preferences-sync.ts`:
//
//   syncShieldNotesOnSignIn(envelopePrivKeys, evmAddress)
//     Called from auth-flow's sign-in/re-auth path while the wallet is
//     briefly alive. Best-effort; swallows errors so a failed sync
//     never blocks sign-in.
//
//   syncShieldNotesExplicit()
//     User-tapped (Sync button). Runs its own PRF ceremony, derives both
//     envelope private keys, runs the same core, then scrubs.
//
//   syncShieldNotesWithKeys(envelopePrivKeys, evmAddress) — internal core.
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
import { deriveEnvelopePrivKeys } from "./derive-addresses";
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
import { noteNullifier } from "./note-nullifier";
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
  /** Spendable notes flipped to `spent` because their nullifier was found
   *  on-chain (spent on another device/origin). */
  reconciledSpent: number;
};

function emptyResult(): SyncShieldNotesResult {
  return {
    added: 0,
    skippedAlreadyPresent: 0,
    skippedByCursor: 0,
    decryptFailed: 0,
    unknownDeployment: 0,
    archivedAdded: 0,
    reconciledSpent: 0,
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

type PlainNote = {
  secret: string;
  owner: string;
  asset_id: string;
  asset_amount: string;
};

/** Trial-decrypt one ECIES blob against every candidate envelope key,
 *  newest scheme first. Returns the plaintext from the first key that
 *  works, or null if none do (blob is for someone else, or for an
 *  envelope path we don't derive). Mirrors sdk/src/sync.ts `tryDecrypt`. */
async function tryDecryptNote(
  ciphertext: string,
  envelopePrivKeys: string[],
): Promise<PlainNote | null> {
  for (const k of envelopePrivKeys) {
    try {
      return await NoteDecryption.decryptNoteData(ciphertext, k);
    } catch {
      // wrong key → not ours under this envelope; try the next.
    }
  }
  return null;
}

export async function syncShieldNotesWithKeys(
  envelopePrivKeys: string[],
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

    // Convex `v.bytes()` can surface as ArrayBuffer or base64url string
    // depending on runtime version. Normalize before hexlifying so the
    // decrypt path always sees `0x…`.
    const ciphertext = ciphertextToHex(row.encryptedPayload);
    const plain = await tryDecryptNote(ciphertext, envelopePrivKeys);
    if (!plain) {
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
        envelopePrivKeys,
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

  // ─── Spent reconciliation ───────────────────────────────────────────
  // Sync otherwise only ever ADDS notes; nothing marks a note spent that
  // was spent on a different device/origin (the optimistic spend write
  // lives only in the IDB that performed it). On-chain a nullifier is
  // unlinkable to its leaf, so we compute each spendable note's nullifier
  // locally and ask the contract which are already in `nullifierUsed`.
  // This is what makes balances converge across devices.
  try {
    await reconcileSpentNotes(deployments, result);
  } catch (e) {
    console.warn("[sync-shield-notes] spent reconciliation failed", e);
  }

  // ─── Retired-deployment archive (ADR 0018) ──────────────────────────
  // Hydrate read-only history for contracts we've redeployed away from,
  // so the wallet's History panel shows the same retired notes on a fresh
  // device. These land in IDB with their OLD deploymentAddress, so they
  // derive as retired (idb-notes.isNoteRetired) and never reach the spend
  // flow. Best-effort: a failure here must not poison live sync.
  try {
    await scanArchivedNotes(envelopePrivKeys, evmAddress, tokens, result);
  } catch (e) {
    console.warn("[sync-shield-notes] archived scan failed", e);
  }

  return result;
}

// Flip spendable notes to `spent` when their nullifier is already on-chain.
// The cross-device/origin spend signal sync otherwise lacks: a note spent
// elsewhere stays `spendable` locally because the optimistic spend write
// lives only in the IDB that performed it. Computed from stored notes alone
// (no PRF — the note carries its own secret), one batched eth_call set per
// deployment.
async function reconcileSpentNotes(
  deployments: ReadonlyArray<{ chainId: number; pampaloAddress: string }>,
  result: SyncShieldNotesResult,
): Promise<void> {
  const convex = getConvexClient();
  if (!convex) return;
  const allNotes = await listNotes();

  for (const dep of deployments) {
    const depAddr = dep.pampaloAddress.toLowerCase();
    // nullifier (lowercased) → note. Only live, positioned, spendable notes
    // on this deployment can have been nullified.
    const byNullifier = new Map<string, StoredNote>();
    for (const n of allNotes) {
      if (n.state !== "spendable") continue;
      if (n.networkChainId !== dep.chainId) continue;
      if (n.deploymentAddress.toLowerCase() !== depAddr) continue;
      const nf = noteNullifier(n);
      if (nf) byNullifier.set(nf.toLowerCase(), n);
    }
    if (byNullifier.size === 0) continue;

    // Download the PUBLIC used-nullifier set (paginated) and match our own
    // notes against it CLIENT-SIDE — the server never learns which
    // nullifiers are ours, and there's deliberately no per-nullifier
    // endpoint (ADR 0019). Stop early once every one of our notes matches.
    const remaining = new Set(byNullifier.keys());
    let cursor: string | null = null;
    for (let page = 0; page < 10_000 && remaining.size > 0; page++) {
      const res: {
        page: string[];
        isDone: boolean;
        continueCursor: string;
      } = await convex.query(api.shieldQueue.store.usedNullifiers, {
        chainId: dep.chainId,
        paginationOpts: { numItems: 512, cursor },
      });
      for (const nf of res.page) {
        const key = nf.toLowerCase();
        const note = byNullifier.get(key);
        if (!note || !remaining.has(key)) continue;
        await patchNoteByLeaf(note.leafCommitment, {
          state: "spent",
          nullifier: key,
        });
        result.reconciledSpent += 1;
        remaining.delete(key);
      }
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
  }
}

// Pull retired self-shields (by shielder) + retired received notes (per
// archived chain) into IDB as read-only history. Mirrors the live paths
// but reads the archive tables and tags notes with the OLD deployment
// address. No cursor — relies on findNote() idempotency (archive sets are
// small / testnet-scale).
async function scanArchivedNotes(
  envelopePrivKeys: string[],
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
    const ciphertext = ciphertextToHex(row.encryptedPayload);
    const plain = await tryDecryptNote(ciphertext, envelopePrivKeys);
    if (!plain) {
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
        envelopePrivKeys,
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
  envelopePrivKeys: string[],
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
    const ciphertext = ciphertextToHex(row.encryptedPayload);
    const plain = await tryDecryptNote(ciphertext, envelopePrivKeys);
    if (!plain) {
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
  envelopePrivKeys: string[],
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
    const ciphertext = ciphertextToHex(row.encryptedPayload);
    const plain = await tryDecryptNote(ciphertext, envelopePrivKeys);
    if (!plain) {
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
  envelopePrivKeys: string[],
  evmAddress: string,
): Promise<void> {
  try {
    await syncShieldNotesWithKeys(envelopePrivKeys, evmAddress);
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
    // Both envelope keys (path-0 + isolated slot-420) so the Sync button
    // recovers mainnet notes, not just Base Sepolia ones.
    return await syncShieldNotesWithKeys(
      deriveEnvelopePrivKeys(mnemonic),
      wallet.address,
    );
  } finally {
    new Uint8Array(dekBytes).fill(0);
    new Uint8Array(mnemonicBuf).fill(0);
  }
}

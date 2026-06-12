// Sync engine — rebuild an agent account's notes + the merkle leaf set
// from chain events, with no Convex dependency.
//
// The contract emits everything we need:
//   LeafInserted(epoch, leafIndex, leafValue)  → exact tree position of
//        every leaf (the index a merkle proof needs). No insertion-order
//        replay; we read the index straight off the event.
//   ShieldQueued(id, …, leafCommitment, …, encryptedPayload)  → trial-
//        decrypt the payload with the envelope key; the ones that decrypt
//        are notes addressed to us.
//   ShieldExecuted/Cancelled/Contested(id)  → shield lifecycle.
//   NotePayload(encryptedNote)  → transfer-output notes (same trial-decrypt).
//   NullifierUsed(nullifier)  → mark our spent inputs.
//
// Single epoch assumed (Base Sepolia v1). Multi-epoch rollover keys the
// leaf table by (epoch, leafIndex) — a TODO when EpochRolledOver fires.

import { Interface } from "ethers";
import type { JsonRpcProvider, Log } from "ethers";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { NoteDecryption } from "@pampalo/shared/classes/Note";
import type { NoteState, Store } from "./store.js";
import { ETH_SENTINEL } from "./constants.js";

const EVENTS = new Interface([
  "event LeafInserted(uint256 indexed epoch, uint256 indexed leafIndex, bytes32 leafValue)",
  "event ShieldQueued(uint256 indexed id, address indexed shielder, address indexed asset, uint256 amount, uint256 leafCommitment, uint64 unlockTime, bytes encryptedPayload)",
  "event ShieldExecuted(uint256 indexed id)",
  "event ShieldCancelled(uint256 indexed id, address indexed by)",
  "event ShieldContested(uint256 indexed id, address indexed by, string reason)",
  "event NullifierUsed(bytes32 indexed nullifier)",
  "event NotePayload(bytes encryptedNote)",
]);

export type AccountKeys = {
  /** Lowercased EVM address — the store account key. */
  evm: string;
  /** Poseidon identifier (0x + 64 hex). */
  poseidon: string;
  /** Path-0 (shared envelope) private key. */
  spendPrivKey: string;
  /** Isolated envelope (slot 420) private key. */
  isoPrivKey: string;
};

export type SyncResult = {
  fromBlock: number;
  toBlock: number;
  leavesIndexed: number;
  notesUpserted: number;
  spentMarked: number;
};

const toHex64 = (v: bigint | string): string =>
  "0x" + BigInt(v).toString(16).padStart(64, "0");
const assetFromId = (id: bigint | string): string =>
  ("0x" + BigInt(id).toString(16).padStart(40, "0")).toLowerCase();

type Plain = { secret: string; owner: string; asset_id: string; asset_amount: string };

async function tryDecrypt(blob: string, keys: AccountKeys): Promise<Plain | null> {
  for (const k of [keys.spendPrivKey, keys.isoPrivKey]) {
    try {
      return await NoteDecryption.decryptNoteData(blob, k);
    } catch {
      // wrong key → not ours under this key; try the next.
    }
  }
  return null;
}

export async function syncDeployment(args: {
  store: Store;
  provider: JsonRpcProvider;
  keys: AccountKeys;
  chainId: number;
  deployment: string;
  fromBlock: number;
  decimalsByAsset: Map<string, number>;
  chunk?: number;
  /** Cap the scan here instead of chain head — useful for bounded
   *  catch-up passes on rate-limited RPCs. */
  toBlock?: number;
}): Promise<SyncResult> {
  const { store, provider, keys, chainId, decimalsByAsset } = args;
  const deployment = args.deployment.toLowerCase();
  const chunk = args.chunk ?? 50_000;
  const account = keys.evm.toLowerCase();
  const decimalsFor = (asset: string): number =>
    decimalsByAsset.get(asset) ?? (asset === ETH_SENTINEL.toLowerCase() ? 18 : 0);

  const cursor = store.getCursor(account, chainId, deployment);
  const start = cursor !== null ? cursor + 1 : args.fromBlock;
  const head = await provider.getBlockNumber();
  const toBlock = args.toBlock !== undefined ? Math.min(args.toBlock, head) : head;
  if (start > toBlock) {
    return { fromBlock: start, toBlock, leavesIndexed: 0, notesUpserted: 0, spentMarked: 0 };
  }

  // ── 1. gather logs in block windows ──────────────────────────────────
  const logs: Log[] = [];
  for (let from = start; from <= toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, toBlock);
    const got = await provider.getLogs({ address: deployment, fromBlock: from, toBlock: to });
    logs.push(...got);
  }
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

  // ── 2. single pass: collect events ───────────────────────────────────
  const leafByCommitment = new Map<string, { epoch: number; leafIndex: number }>();
  const shieldQueued = new Map<
    string,
    { leaf: string; unlockTime: number; payload: string; queuedTxHash: string }
  >();
  const executed = new Set<string>();
  const cancelled = new Set<string>();
  const contested = new Set<string>();
  const notePayloads: string[] = [];
  const nullifiers = new Set<string>();

  for (const log of logs) {
    let parsed;
    try {
      parsed = EVENTS.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // cap/halt events we don't model
    }
    if (!parsed) continue;

    switch (parsed.name) {
      case "LeafInserted": {
        const commitment = toHex64(BigInt(parsed.args.leafValue)).toLowerCase();
        const leafIndex = Number(parsed.args.leafIndex);
        leafByCommitment.set(commitment, {
          epoch: Number(parsed.args.epoch),
          leafIndex,
        });
        store.insertLeaf(chainId, deployment, leafIndex, commitment);
        break;
      }
      case "ShieldQueued":
        shieldQueued.set(parsed.args.id.toString(), {
          leaf: toHex64(parsed.args.leafCommitment).toLowerCase(),
          unlockTime: Number(parsed.args.unlockTime),
          payload: parsed.args.encryptedPayload,
          queuedTxHash: log.transactionHash,
        });
        break;
      case "ShieldExecuted":
        executed.add(parsed.args.id.toString());
        break;
      case "ShieldCancelled":
        cancelled.add(parsed.args.id.toString());
        break;
      case "ShieldContested":
        contested.add(parsed.args.id.toString());
        break;
      case "NotePayload":
        notePayloads.push(parsed.args.encryptedNote);
        break;
      case "NullifierUsed":
        nullifiers.add(toHex64(parsed.args.nullifier).toLowerCase());
        break;
    }
  }

  let notesUpserted = 0;
  let spentMarked = 0;
  const handled = new Set<string>(); // leaf commitments handled as shields

  // ── 3. shields: trial-decrypt + lifecycle ────────────────────────────
  for (const [id, sq] of shieldQueued) {
    const plain = await tryDecrypt(sq.payload, keys);
    if (!plain) continue;
    const owner = toHex64(plain.owner).toLowerCase();
    if (owner !== keys.poseidon.toLowerCase()) continue;

    handled.add(sq.leaf);
    const pos = leafByCommitment.get(sq.leaf);
    let state: NoteState = "queued";
    if (cancelled.has(id)) state = "cancelled";
    else if (contested.has(id)) state = "contested";
    else if (executed.has(id) || pos) state = "spendable";

    const asset = assetFromId(plain.asset_id);
    store.upsertNote({
      account,
      chainId,
      deployment,
      leafCommitment: sq.leaf,
      asset,
      assetDecimals: decimalsFor(asset),
      amount: plain.asset_amount,
      owner,
      secret: toHex64(plain.secret),
      origin: "shield",
      state,
      unlockTime: sq.unlockTime,
      queuedTxHash: sq.queuedTxHash,
      treeIndex: pos?.epoch,
      leafIndex: pos?.leafIndex,
    });
    notesUpserted += 1;
  }

  // ── 4. transfer-in notes: trial-decrypt NotePayload ──────────────────
  for (const blob of notePayloads) {
    const plain = await tryDecrypt(blob, keys);
    if (!plain) continue;
    const owner = toHex64(plain.owner).toLowerCase();
    if (owner !== keys.poseidon.toLowerCase()) continue;

    const leaf = toHex64(
      poseidon2Hash([
        BigInt(plain.asset_id),
        BigInt(plain.asset_amount),
        BigInt(plain.owner),
        BigInt(plain.secret),
      ]),
    ).toLowerCase();
    if (handled.has(leaf)) continue; // already recorded as a shield note
    const pos = leafByCommitment.get(leaf);
    if (!pos) continue; // leaf not yet inserted — pick up next sync

    const asset = assetFromId(plain.asset_id);
    store.upsertNote({
      account,
      chainId,
      deployment,
      leafCommitment: leaf,
      asset,
      assetDecimals: decimalsFor(asset),
      amount: plain.asset_amount,
      owner,
      secret: toHex64(plain.secret),
      origin: "transferIn",
      state: "spendable",
      treeIndex: pos.epoch,
      leafIndex: pos.leafIndex,
    });
    notesUpserted += 1;
  }

  // ── 5. mark spent inputs from nullifiers ─────────────────────────────
  if (nullifiers.size) {
    for (const note of store.listNotes({ account, chainId })) {
      if (note.state === "spent" || note.leafIndex === undefined) continue;
      const nf = toHex64(
        poseidon2Hash([
          BigInt(note.leafIndex),
          BigInt(note.owner),
          BigInt(note.secret),
          BigInt(note.asset),
          BigInt(note.amount),
        ]),
      ).toLowerCase();
      if (nullifiers.has(nf)) {
        store.patchNote(account, note.leafCommitment, { state: "spent", nullifier: nf });
        spentMarked += 1;
      }
    }
  }

  store.setCursor(account, chainId, deployment, toBlock);
  return {
    fromBlock: start,
    toBlock,
    leavesIndexed: leafByCommitment.size,
    notesUpserted,
    spentMarked,
  };
}

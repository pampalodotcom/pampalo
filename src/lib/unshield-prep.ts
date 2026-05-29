// Pure helpers for preparing an `unshieldBundled` transaction. Mirrors
// `transfer-prep.ts` in structure (lazy modules, warm hook, single
// `prepare*` entry point), specialised for the transfer_external
// circuit which adds an EXTERNAL_ADDRESS slot per output.
//
// Scope (matches the demo-day triage):
//   - Slider-drag UX: one input note, exactly one exit (to the user's
//     own EVM), zero-or-one self-change note. ADR 0011 keeps shield
//     to self only; for unshield the destination is on-chain anyway,
//     so for v1 we always exit to msg.sender. A future "unshield to
//     a friend's 0x" surface plugs in by passing a different
//     `exitAddress` here.
//   - Always uses `unshieldBundled` (vs the bare `unshield` circuit),
//     because change is the common case. The bare circuit becomes an
//     emergency-escape lane in a future iteration.
//   - Self-broadcast via signTransactionWithPasskey. No relayer yet.
//
// Public-input layout (positional, mirrors Pampalo.unshieldBundled):
//
//   [0]                              root
//   [1..1+NOTE_COUNT)                nullifiers (3 slots)
//   [1+NOTE_COUNT..1+2*NOTE_COUNT)   output commitments — 0 for exit
//                                    slots, leaf hash for internal
//                                    (change) slots
//   [exitAssetStart..]               exit_assets[3]
//   [exitAmountStart..]              exit_amounts[3]
//   [exitAddressStart..]             exit_addresses[3]
//   [...]                            exit_address_hashes[3] (verifier
//                                    consumes — frontrun-resistance)
//
// At NOTE_COUNT = 3 that's 25 public inputs total.

import { Interface } from "ethers";
import { POSEIDON_MAX } from "./derive-addresses";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";

const UNSHIELD_BUNDLED_IFACE = new Interface([
  "function unshieldBundled(bytes proof, bytes32[] publicInputs, bytes[] payload) external",
]);

// Matches the circuit's `NOTE_COUNT` global.
const NOTE_COUNT = 3;

export type UnshieldInputNote = {
  /** Lowercased asset address. */
  asset: string;
  /** Amount in base units. */
  amount: bigint;
  /** Per-note random secret as decimal string or 0x + 64 hex. */
  secret: string;
  /** Owner = poseidon2([privateKey]). Must equal the sender's own
   *  Poseidon identifier (transfer-prep enforces the same invariant). */
  owner: string;
  /** Absolute leaf index in the merkle tree. */
  leafIndex: number;
};

export type UnshieldInput = {
  chainId: number;
  /** Lowercased Pampalo router address on `chainId`. */
  pampaloAddress: string;
  /** 1 spendable input note for v1 (single-input demo). */
  inputNote: UnshieldInputNote;
  /** EVM address receiving the public payout (lowercased 0x…). For
   *  v1 this is always the sender's own EVM address. */
  exitAddress: string;
  /** Amount to exit, in base units. Must equal `inputNote.amount`
   *  when there's no change. */
  exitAmount: bigint;
  /** Sender's EVM private key (0x + 64 hex). Drives the input's
   *  `owner_secret` — same convention as transfer-prep. */
  walletPrivateKey: string;
  /** Sender's Poseidon (for the self-change output's `owner`). */
  selfPoseidon: string;
  /** Sender's envelope pubkey (for ECIES of the self-change output). */
  selfEnvelopePubKey: string;
  /** Pre-built local merkle tree mirror — caller populates from
   *  `shieldQueue.store.leavesForChain`. */
  tree: PoseidonMerkleTreeType;
};

export type PreparedUnshieldTx = {
  to: string;
  data: string;
  value: string;          // decimal wei — always "0" for unshieldBundled
  chainId: number;

  proofBytes: string;                 // 0x hex
  publicInputs: readonly string[];    // 0x… hex; 25 slots at NOTE_COUNT=3
  payload: readonly string[];         // 3 entries; "0x" for exit/empty

  /** Self-change output, if any. Caller writes this into IDB
   *  optimistically on broadcast accept. Undefined when the exit
   *  consumes the entire input. */
  changeOutput?: {
    secret: string;        // decimal string
    owner: string;         // 0x + 64 hex
    asset: string;         // lowercased
    amount: string;        // base units, decimal string
    leafCommitment: string; // 0x + 64 hex
    encryptedPayload: string; // 0x hex (ECIES blob)
  };
  /** Nullifier of the spent input. Caller patches the IDB note. */
  spentNullifier: string;
  /** Echo of the exit so the confirm UI can show recipient + amount. */
  exit: {
    asset: string;
    amount: string;        // base units, decimal string
    address: string;       // lowercased 0x…
  };
};

// ─── Background prefetch / warmup ────────────────────────────────────────

type WarmModules = {
  UnshieldBundled: unknown;
  NoteEncryption: unknown;
  PoseidonMerkleTree: unknown;
  poseidon2Hash: unknown;
};

let _warmPromise: Promise<WarmModules> | null = null;

async function loadModules(): Promise<WarmModules> {
  const [ubMod, noteMod, treeMod, poseidonMod] = await Promise.all([
    import("@pampalo/shared/classes/UnshieldBundled"),
    import("@pampalo/shared/classes/Note"),
    import("@pampalo/shared/classes/PoseidonMerkleTree"),
    import("@zkpassport/poseidon2"),
  ]);
  return {
    UnshieldBundled: ubMod.UnshieldBundled,
    NoteEncryption: noteMod.NoteEncryption,
    PoseidonMerkleTree: treeMod.PoseidonMerkleTree,
    poseidon2Hash: poseidonMod.poseidon2Hash,
  };
}

/**
 * Idle-time warm-up. Mount from the wallet route via
 * `requestIdleCallback` so bb.js WASM + the transfer_external circuit
 * JSON are resident before the user drags the slider toward public.
 */
export function warmUnshield(): Promise<void> {
  if (!_warmPromise) _warmPromise = loadModules();
  return _warmPromise.then(async (mods) => {
    type UnshieldCtor = new () => { init: () => Promise<void> };
    const ub = new (mods.UnshieldBundled as UnshieldCtor)();
    await ub.init();
  });
}

async function getWarmModules(): Promise<WarmModules> {
  if (!_warmPromise) _warmPromise = loadModules();
  return await _warmPromise;
}

function randomSecret(): bigint {
  const bytes = new Uint8Array(32);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    crypto.getRandomValues(bytes);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    if (v < POSEIDON_MAX) return v;
  }
  throw new Error("randomSecret: rejection sampling failed 30× in a row");
}

/**
 * Build everything needed to broadcast an `unshieldBundled` tx —
 * proof, ECIES change-output payload, calldata — without broadcasting.
 * The caller wraps in `signTransactionWithPasskey` (or, eventually,
 * a relayer).
 */
export async function prepareUnshield(
  input: UnshieldInput,
): Promise<PreparedUnshieldTx> {
  const {
    chainId,
    pampaloAddress,
    inputNote,
    exitAddress,
    exitAmount,
    walletPrivateKey,
    selfPoseidon,
    selfEnvelopePubKey,
    tree,
  } = input;

  const noteAmount = inputNote.amount;
  if (exitAmount <= 0n) throw new Error("exitAmount must be > 0");
  if (exitAmount > noteAmount) {
    throw new Error("exitAmount exceeds input note amount");
  }
  const changeAmount = noteAmount - exitAmount;

  const mods = await getWarmModules();
  type UnshieldCtor = new () => {
    init: () => Promise<void>;
    unshieldBundledNoir: {
      execute: (
        witness: Record<string, unknown>,
      ) => Promise<{ witness: Uint8Array }>;
    };
    unshieldBundledBackend: {
      generateProof: (
        witness: Uint8Array,
        opts: { keccakZK: boolean },
      ) => Promise<{ proof: Uint8Array | string; publicInputs: string[] }>;
    };
  };
  type NoteEncryptionStatic = {
    encryptNoteData: (
      data: {
        secret: string | bigint;
        owner: string | bigint;
        asset_id: string | bigint;
        asset_amount: string | bigint;
      },
      pub: string,
    ) => Promise<string>;
  };
  const UnshieldBundled = mods.UnshieldBundled as UnshieldCtor;
  const NoteEncryption = mods.NoteEncryption as NoteEncryptionStatic;
  const poseidon2Hash = mods.poseidon2Hash as (xs: bigint[]) => bigint;

  // owner_secret = privKey reduced into the BN254 scalar field. Same
  // reduction transfer-prep does — see derive-addresses.ts and the
  // POSEIDON_MAX const.
  const ownerSecret = BigInt(walletPrivateKey) % POSEIDON_MAX;

  // ─── Input witness ────────────────────────────────────────────────────
  const assetIdBig = BigInt(inputNote.asset);
  const ownerBig = BigInt(inputNote.owner);
  const secretBig = BigInt(inputNote.secret);
  const root = await tree.getRoot();
  const proof = await tree.getProof(inputNote.leafIndex);
  if (proof.siblings.length !== 11 || proof.indices.length !== 11) {
    throw new Error(
      `unshield-prep: merkle proof has wrong length for leaf ${inputNote.leafIndex}`,
    );
  }

  const nullifier = poseidon2Hash([
    BigInt(inputNote.leafIndex),
    ownerBig,
    secretBig,
    assetIdBig,
    noteAmount,
  ]);

  type CircuitInputNote = {
    asset_id: string;
    asset_amount: string;
    owner: string;
    owner_secret: string;
    secret: string;
    leaf_index: string;
    path: string[];
    path_indices: string[];
  };
  type CircuitOutputNote = {
    owner: string;
    secret: string;
    asset_id: string;
    asset_amount: string;
    external_address: string;
  };

  const circuitInputs: CircuitInputNote[] = [];
  circuitInputs.push({
    asset_id: assetIdBig.toString(),
    asset_amount: noteAmount.toString(),
    owner: ownerBig.toString(),
    owner_secret: ownerSecret.toString(),
    secret: secretBig.toString(),
    leaf_index: inputNote.leafIndex.toString(),
    path: proof.siblings.map((s) => s.toString()),
    path_indices: proof.indices.map((i) => i.toString()),
  });
  while (circuitInputs.length < NOTE_COUNT) {
    circuitInputs.push({
      asset_id: "0",
      asset_amount: "0",
      owner: "0",
      owner_secret: "0",
      secret: "0",
      leaf_index: "0",
      path: new Array<string>(11).fill("0"),
      path_indices: new Array<string>(11).fill("0"),
    });
  }
  const nullifiers: bigint[] = [nullifier, 0n, 0n];

  // ─── Output + exit witness ────────────────────────────────────────────
  // Slot 0 = exit. Slot 1 = change (if any). Slot 2 = empty.
  const exitAddressBig = BigInt(exitAddress);
  const exitAddressHash = poseidon2Hash([exitAddressBig]);

  const circuitOutputs: CircuitOutputNote[] = [];
  const outputHashes: bigint[] = [];
  const exitAssets: bigint[] = [];
  const exitAmounts: bigint[] = [];
  const exitAddresses: bigint[] = [];
  const exitAddressHashes: bigint[] = [];
  const payloads: string[] = [];

  // Exit slot.
  circuitOutputs.push({
    owner: "0",
    secret: "0",
    asset_id: assetIdBig.toString(),
    asset_amount: exitAmount.toString(),
    external_address: exitAddressBig.toString(),
  });
  outputHashes.push(0n); // Exit slots aren't inserted; commitment is unused.
  exitAssets.push(assetIdBig);
  exitAmounts.push(exitAmount);
  exitAddresses.push(exitAddressBig);
  exitAddressHashes.push(exitAddressHash);
  payloads.push("0x"); // No NotePayload for exit slot — receiver is on-chain.

  let changeBookkeeping: PreparedUnshieldTx["changeOutput"] = undefined;

  if (changeAmount > 0n) {
    const changeSecret = randomSecret();
    const changeOwnerBig = BigInt(selfPoseidon);
    const changeLeaf = poseidon2Hash([
      assetIdBig,
      changeAmount,
      changeOwnerBig,
      changeSecret,
    ]);
    const changeLeafHex =
      "0x" + changeLeaf.toString(16).padStart(64, "0");

    circuitOutputs.push({
      owner: changeOwnerBig.toString(),
      secret: changeSecret.toString(),
      asset_id: assetIdBig.toString(),
      asset_amount: changeAmount.toString(),
      external_address: "0",
    });
    outputHashes.push(changeLeaf);
    exitAssets.push(0n);
    exitAmounts.push(0n);
    exitAddresses.push(0n);
    exitAddressHashes.push(0n);

    const ecies = await NoteEncryption.encryptNoteData(
      {
        secret: changeSecret,
        owner: changeOwnerBig,
        asset_id: assetIdBig,
        asset_amount: changeAmount,
      },
      selfEnvelopePubKey,
    );
    payloads.push(ecies);

    changeBookkeeping = {
      secret: changeSecret.toString(),
      owner: "0x" + changeOwnerBig.toString(16).padStart(64, "0"),
      asset: inputNote.asset.toLowerCase(),
      amount: changeAmount.toString(),
      leafCommitment: changeLeafHex,
      encryptedPayload: ecies,
    };
  }

  // Empty slot pad.
  while (circuitOutputs.length < NOTE_COUNT) {
    circuitOutputs.push({
      owner: "0",
      secret: "0",
      asset_id: "0",
      asset_amount: "0",
      external_address: "0",
    });
    outputHashes.push(0n);
    exitAssets.push(0n);
    exitAmounts.push(0n);
    exitAddresses.push(0n);
    exitAddressHashes.push(0n);
    payloads.push("0x");
  }

  // ─── Witness + proof ─────────────────────────────────────────────────
  const ub = new UnshieldBundled();
  await ub.init();
  const { witness } = await ub.unshieldBundledNoir.execute({
    root: root.toString(),
    input_notes: circuitInputs as unknown,
    output_notes: circuitOutputs as unknown,
    nullifiers: nullifiers.map((n) => n.toString()),
    output_hashes: outputHashes.map((h) => h.toString()),
    exit_assets: exitAssets.map((x) => x.toString()),
    exit_amounts: exitAmounts.map((x) => x.toString()),
    exit_addresses: exitAddresses.map((x) => x.toString()),
    exit_address_hashes: exitAddressHashes.map((x) => x.toString()),
  });
  const generated = await ub.unshieldBundledBackend.generateProof(witness, {
    keccakZK: true,
  });
  const proofBytes =
    typeof generated.proof === "string"
      ? generated.proof
      : "0x" +
        Array.from(generated.proof)
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");
  const publicInputs = (generated.publicInputs as readonly string[]).map(
    (s) => s,
  ) as readonly string[];

  const data = UNSHIELD_BUNDLED_IFACE.encodeFunctionData("unshieldBundled", [
    proofBytes,
    publicInputs,
    payloads,
  ]);

  return {
    to: pampaloAddress,
    data,
    value: "0",
    chainId,
    proofBytes,
    publicInputs,
    payload: payloads,
    changeOutput: changeBookkeeping,
    spentNullifier: nullifier.toString(),
    exit: {
      asset: inputNote.asset.toLowerCase(),
      amount: exitAmount.toString(),
      address: exitAddress.toLowerCase(),
    },
  };
}

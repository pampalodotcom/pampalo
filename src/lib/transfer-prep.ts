// Pure helpers for preparing a `transfer` transaction. Mirrors the
// shape of `shield-prep.ts` — lazy-loads the heavy proof-gen + ECIES
// dependencies, exposes a `warmTransfer()` that the wallet route can
// fire on idle, and returns a fully prepared unsigned-tx envelope the
// caller drops into `signTransactionWithPasskey` (self-broadcast)
// or `transfers.relay` (once the relayer ships — see TRANSFERS.md).
//
// Scope (matches the demo-day triage in TRANSFERS.md §10):
//
//   - native ETH only. ERC-20 + bundled-unshield lands later.
//   - single input note → 1 recipient + 1 self-change output.
//     The circuit supports up to 3 inputs / 3 outputs; we exercise the
//     simplest split first and grow surface as the UI lands.
//   - caller-driven coin selection. `prepareTransfer` does not pick
//     input notes or compute change; the caller (UI hook /
//     transfer-planner) constructs the input list + output specs and
//     hands us a self-consistent ledger. Keeps the prep function pure.
//   - caller-built merkle tree. The Pampalo merkle tree mirror lives
//     in `@pampalo/shared/classes/PoseidonMerkleTree`; the caller is
//     responsible for inserting all known leaves (from a Convex
//     `merkle.leaves` query, when that lands) and passing the
//     populated tree in. Same separation as shield-prep: this module
//     is pure proof+ECIES+calldata.
//
// Public-input layout the contract reads positionally (see
// `Pampalo.transfer` in contracts/contracts/Pampalo.sol):
//
//   publicInputs[0]                 = root
//   publicInputs[1..1+NOTE_COUNT)   = nullifiers per input slot
//   publicInputs[1+NOTE_COUNT..]    = output commitments per output slot
//
// At NOTE_COUNT = 3 this is exactly 7 entries: root, n0, n1, n2, c0, c1, c2.
// Empty slots get 0 for nullifier / 0 for output commitment.

import { Interface } from "ethers";
import { POSEIDON_MAX } from "./derive-addresses";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";

const TRANSFER_IFACE = new Interface([
  "function transfer(bytes proof, bytes32[] publicInputs, bytes[] payload) external",
]);

// Matches the circuit's `NOTE_COUNT` global. Bumping this requires
// bumping the circuit too — keep in sync.
const NOTE_COUNT = 3;

export type TransferRecipient = {
  /** Recipient's Poseidon identifier (0x + 64 hex). The note's owner. */
  poseidonOwner: string;
  /** Recipient's uncompressed secp256k1 public key (0x04 || X || Y).
   *  Used as the ECIES target for the encrypted note payload. */
  envelopePubKey: string;
  /** Lowercased asset address. ETH_SENTINEL for native. */
  asset: string;
  /** Amount in base units (token wei). */
  amount: bigint;
};

export type TransferInputNote = {
  /** Lowercased asset address. */
  asset: string;
  /** Amount in base units. */
  amount: bigint;
  /** Per-note random secret as decimal string or 0x + 64 hex. */
  secret: string;
  /** Owner = poseidon2([privateKey]). Must equal `selfPoseidon` for v1
   *  (we can only spend our own notes). */
  owner: string;
  /** Absolute leaf index in the merkle tree (matches `tree.insert` order). */
  leafIndex: number;
};

export type TransferInput = {
  chainId: number;
  /** Lowercased Pampalo router address on `chainId`. */
  pampaloAddress: string;

  /** 1..NOTE_COUNT input notes the sender will spend. */
  inputNotes: TransferInputNote[];
  /** 1..NOTE_COUNT outputs — recipients + self-change. */
  outputs: TransferRecipient[];

  /** Sender's EVM private key (0x + 64 hex). Drives the input's
   *  `owner_secret` field; the circuit verifies
   *  `poseidon2([owner_secret]) === owner`. */
  walletPrivateKey: string;

  /** Pre-built merkle tree containing every executed leaf on this
   *  chain. The caller is responsible for population — `transfer-prep`
   *  only queries `getRoot()` and `getProof(leafIndex)`. */
  tree: PoseidonMerkleTreeType;
};

export type PreparedTransferTx = {
  /** Unsigned-tx envelope. Feed into signTransactionWithPasskey
   *  (self-broadcast) or `transfers.relay` (relayer, future). */
  to: string;
  data: string;
  value: string; // decimal wei — always "0" for transfer
  chainId: number;

  proofBytes: string;               // 0x hex (UltraHonk proof)
  publicInputs: readonly string[];  // 0x… hex; sized 7
  payload: readonly string[];       // 3 entries; empty slots are "0x"

  /** Per-output bookkeeping the caller can drop into IDB optimistically
   *  on broadcast accept. `change` outputs (owner === selfPoseidon)
   *  become spendable notes immediately on confirm; recipient outputs
   *  belong to the recipient and are NOT inserted into this wallet's IDB. */
  outputs: Array<{
    secret: string;        // decimal string
    owner: string;         // 0x + 64 hex
    asset: string;         // lowercased
    amount: string;        // base units, decimal string
    leafCommitment: string; // 0x + 64 hex
    encryptedPayload: string; // 0x hex (ECIES blob)
  }>;
  /** Decimal-string nullifiers for each input note, in input order.
   *  Caller marks the matching IDB notes spent with these. */
  spentNullifiers: string[];
};

// ─── Background prefetch / warmup ────────────────────────────────────────

type WarmModules = {
  Transfer: unknown;
  NoteEncryption: unknown;
  PoseidonMerkleTree: unknown;
  poseidon2Hash: unknown;
};

let _warmPromise: Promise<WarmModules> | null = null;

async function loadModules(): Promise<WarmModules> {
  const [transferMod, noteMod, treeMod, poseidonMod] = await Promise.all([
    import("@pampalo/shared/classes/Transfer"),
    import("@pampalo/shared/classes/Note"),
    import("@pampalo/shared/classes/PoseidonMerkleTree"),
    import("@zkpassport/poseidon2"),
  ]);
  return {
    Transfer: transferMod.Transfer,
    NoteEncryption: noteMod.NoteEncryption,
    PoseidonMerkleTree: treeMod.PoseidonMerkleTree,
    poseidon2Hash: poseidonMod.poseidon2Hash,
  };
}

/**
 * Idle-time warm-up. Mount from the wallet route via
 * `requestIdleCallback` so the bb.js WASM + transfer circuit JSON are
 * resident before the user opens the Send sheet.
 */
export function warmTransfer(): Promise<void> {
  if (!_warmPromise) _warmPromise = loadModules();
  return _warmPromise.then(async (mods) => {
    type TransferCtor = new () => { init: () => Promise<void> };
    const transfer = new (mods.Transfer as TransferCtor)();
    await transfer.init();
  });
}

async function getWarmModules(): Promise<WarmModules> {
  if (!_warmPromise) _warmPromise = loadModules();
  return await _warmPromise;
}

/**
 * Cryptographically random 256-bit secret in `[0, BN254_FIELD_PRIME)`.
 * Same reject-sample pattern as `shield-prep.ts`.
 */
export function randomSecret(): bigint {
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
 * Build everything needed to broadcast a `transfer` tx — proof, ECIES
 * payloads, calldata — without broadcasting. Caller wraps in either
 * `signTransactionWithPasskey` (self-broadcast) or `transfers.relay`.
 *
 * Validation:
 *   - inputs.length ∈ [1, NOTE_COUNT]
 *   - outputs.length ∈ [1, NOTE_COUNT]
 *   - per-asset input sum === per-asset output sum (mirrors the
 *     circuit's `assert_balanced` so the user gets a clear error
 *     up-front instead of a useless "proof failed" later).
 */
export async function prepareTransfer(
  input: TransferInput,
): Promise<PreparedTransferTx> {
  const {
    chainId,
    pampaloAddress,
    inputNotes,
    outputs,
    walletPrivateKey,
    tree,
  } = input;

  if (inputNotes.length === 0 || inputNotes.length > NOTE_COUNT) {
    throw new Error(`inputNotes.length must be 1..${NOTE_COUNT}`);
  }
  if (outputs.length === 0 || outputs.length > NOTE_COUNT) {
    throw new Error(`outputs.length must be 1..${NOTE_COUNT}`);
  }

  // Pre-flight: balance check per asset. Same invariant the circuit
  // enforces; failing fast here gives a useful error message.
  const inSumByAsset = new Map<string, bigint>();
  const outSumByAsset = new Map<string, bigint>();
  for (const n of inputNotes) {
    inSumByAsset.set(
      n.asset.toLowerCase(),
      (inSumByAsset.get(n.asset.toLowerCase()) ?? 0n) + n.amount,
    );
  }
  for (const o of outputs) {
    outSumByAsset.set(
      o.asset.toLowerCase(),
      (outSumByAsset.get(o.asset.toLowerCase()) ?? 0n) + o.amount,
    );
  }
  for (const [asset, sumIn] of inSumByAsset) {
    const sumOut = outSumByAsset.get(asset) ?? 0n;
    if (sumIn !== sumOut) {
      throw new Error(
        `transfer-prep: asset ${asset} unbalanced (in=${sumIn}, out=${sumOut})`,
      );
    }
  }
  for (const [asset, sumOut] of outSumByAsset) {
    if (!inSumByAsset.has(asset)) {
      throw new Error(
        `transfer-prep: asset ${asset} appears only on output side (sum=${sumOut})`,
      );
    }
  }

  const mods = await getWarmModules();
  type TransferCtor = new () => {
    init: () => Promise<void>;
    transferNoir: {
      execute: (
        witness: Record<string, unknown>,
      ) => Promise<{ witness: Uint8Array }>;
    };
    transferBackend: {
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
  const Transfer = mods.Transfer as TransferCtor;
  const NoteEncryption = mods.NoteEncryption as NoteEncryptionStatic;
  const poseidon2Hash = mods.poseidon2Hash as (xs: bigint[]) => bigint;

  // Sender's owner_secret = privateKey reduced into the BN254 scalar
  // field. The circuit treats each Field input as < POSEIDON_MAX and
  // rejects anything above with "exceeds field modulus" — raw
  // secp256k1 keys are 256-bit so sometimes overflow. The reduction
  // is the same one zkpassport/poseidon2 applies internally when it
  // computes the user's Poseidon identifier (see derive-addresses.ts).
  const ownerSecret = BigInt(walletPrivateKey) % POSEIDON_MAX;

  // ─── Build the input note witnesses + nullifiers ──────────────────────
  type CircuitInputNote = {
    asset_id: string;
    asset_amount: string;
    owner: string;
    owner_secret: string;
    secret: string;
    leaf_index: string;
    path: string[];        // length HEIGHT - 1 = 11
    path_indices: string[]; // length HEIGHT - 1 = 11
  };
  type CircuitOutputNote = {
    owner: string;
    secret: string;
    asset_id: string;
    asset_amount: string;
  };

  const root = await tree.getRoot();

  const circuitInputs: CircuitInputNote[] = [];
  const nullifiers: bigint[] = [];
  const spentNullifierStrings: string[] = [];

  for (const n of inputNotes) {
    const assetIdBig = BigInt(n.asset);
    const amountBig = n.amount;
    const ownerBig = BigInt(n.owner);
    const secretBig = BigInt(n.secret);
    const leafIndex = n.leafIndex;
    const proof = await tree.getProof(leafIndex);
    if (proof.siblings.length !== 11 || proof.indices.length !== 11) {
      throw new Error(
        `transfer-prep: merkle proof has wrong length for leaf ${leafIndex}`,
      );
    }

    const nullifier = poseidon2Hash([
      BigInt(leafIndex),
      ownerBig,
      secretBig,
      assetIdBig,
      amountBig,
    ]);
    nullifiers.push(nullifier);
    spentNullifierStrings.push(nullifier.toString());

    circuitInputs.push({
      asset_id: assetIdBig.toString(),
      asset_amount: amountBig.toString(),
      owner: ownerBig.toString(),
      owner_secret: ownerSecret.toString(),
      secret: secretBig.toString(),
      leaf_index: leafIndex.toString(),
      path: proof.siblings.map((s) => s.toString()),
      path_indices: proof.indices.map((i) => i.toString()),
    });
  }
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
    nullifiers.push(0n);
  }

  // ─── Build the output note witnesses + commitments + ECIES blobs ─────
  const circuitOutputs: CircuitOutputNote[] = [];
  const outputHashes: bigint[] = [];
  const outputBookkeeping: PreparedTransferTx["outputs"] = [];
  const ecieBlobs: string[] = [];

  for (const o of outputs) {
    const secret = randomSecret();
    const assetIdBig = BigInt(o.asset);
    const ownerBig = BigInt(o.poseidonOwner);
    const amountBig = o.amount;

    // Leaf = poseidon2([asset_id, asset_amount, owner, secret]). Same
    // 4-input layout as shield (and the circuit's `reconstruct_leaf`).
    const leaf = poseidon2Hash([assetIdBig, amountBig, ownerBig, secret]);
    outputHashes.push(leaf);

    circuitOutputs.push({
      owner: ownerBig.toString(),
      secret: secret.toString(),
      asset_id: assetIdBig.toString(),
      asset_amount: amountBig.toString(),
    });

    const blob = await NoteEncryption.encryptNoteData(
      {
        secret,
        owner: ownerBig,
        asset_id: assetIdBig,
        asset_amount: amountBig,
      },
      o.envelopePubKey,
    );

    outputBookkeeping.push({
      secret: secret.toString(),
      owner: "0x" + ownerBig.toString(16).padStart(64, "0"),
      asset: o.asset.toLowerCase(),
      amount: amountBig.toString(),
      leafCommitment: "0x" + leaf.toString(16).padStart(64, "0"),
      encryptedPayload: blob,
    });
    ecieBlobs.push(blob);
  }
  while (circuitOutputs.length < NOTE_COUNT) {
    circuitOutputs.push({
      owner: "0",
      secret: "0",
      asset_id: "0",
      asset_amount: "0",
    });
    outputHashes.push(0n);
  }
  while (ecieBlobs.length < NOTE_COUNT) ecieBlobs.push("0x");

  // ─── Witness + proof ─────────────────────────────────────────────────
  const transfer = new Transfer();
  await transfer.init();
  const { witness } = await transfer.transferNoir.execute({
    root: root.toString(),
    input_notes: circuitInputs as unknown,
    output_notes: circuitOutputs as unknown,
    nullifiers: nullifiers.map((n) => n.toString()),
    output_hashes: outputHashes.map((h) => h.toString()),
  });
  const proof = await transfer.transferBackend.generateProof(witness, {
    keccakZK: true,
  });

  // Normalise proof bytes — bb.js returns Uint8Array on newer builds,
  // hex string on older. Same shape as shield-prep.
  const proofBytes =
    typeof proof.proof === "string"
      ? proof.proof
      : "0x" +
        Array.from(proof.proof)
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");
  const publicInputs = (proof.publicInputs as readonly string[]).map(
    (s) => s,
  ) as readonly string[];

  // ─── Calldata ────────────────────────────────────────────────────────
  const data = TRANSFER_IFACE.encodeFunctionData("transfer", [
    proofBytes,
    publicInputs,
    ecieBlobs,
  ]);

  return {
    to: pampaloAddress,
    data,
    value: "0",
    chainId,
    proofBytes,
    publicInputs,
    payload: ecieBlobs,
    outputs: outputBookkeeping,
    spentNullifiers: spentNullifierStrings,
  };
}

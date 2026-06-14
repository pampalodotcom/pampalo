// Proof-carrying intent builders: shield / transfer / unshield.
//
// Faithful Node ports of the web app's shield-prep / transfer-prep /
// unshield-prep. Each builds an unsigned tx envelope (to, data, value) +
// the bookkeeping the caller writes to the store on broadcast — pure
// proof + ECIES + calldata, no signing, no network. This is the
// intent/sign split (ADR 0014): the same builder feeds local signing now
// and the keyless Proposal flow later.

import { Interface } from "ethers";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { Shield } from "@pampalo/shared/classes/Shield";
import { Swap } from "@pampalo/shared/classes/Swap";
import { Transfer } from "@pampalo/shared/classes/Transfer";
import { UnshieldBundled } from "@pampalo/shared/classes/UnshieldBundled";
import { NoteEncryption } from "@pampalo/shared/classes/Note";
import { PoseidonMerkleTree } from "@pampalo/shared/classes/PoseidonMerkleTree";
import { POSEIDON_MAX } from "./addresses.js";
import { ETH_SENTINEL, isNativeAsset } from "./constants.js";

const TREE_HEIGHT = 12;
const NOTE_COUNT = 3;

const SHIELD_NATIVE = new Interface([
  "function shieldNative(bytes proof, bytes32[] publicInputs, bytes encryptedPayload) external payable returns (uint256 id)",
]);
const SHIELD_ERC20 = new Interface([
  "function shield(address erc20, uint256 amount, bytes proof, bytes32[] publicInputs, bytes encryptedPayload) external returns (uint256 id)",
]);
const TRANSFER = new Interface([
  "function transfer(bytes proof, bytes32[] publicInputs, bytes[] payload) external",
]);
const UNSHIELD_BUNDLED = new Interface([
  "function unshieldBundled(bytes proof, bytes32[] publicInputs, bytes[] payload) external",
]);
const PRIVATE_SWAP = new Interface([
  "function privateSwap(bytes proof, bytes32[] publicInputs, bytes route, bytes[] payload) external",
]);

const hex64 = (v: bigint): string => "0x" + v.toString(16).padStart(64, "0");

/** Cryptographically random 256-bit secret in `[0, BN254_PRIME)`. */
export function randomSecret(): bigint {
  const bytes = new Uint8Array(32);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    globalThis.crypto.getRandomValues(bytes);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    if (v < POSEIDON_MAX) return v;
  }
  throw new Error("randomSecret: rejection sampling failed 30× in a row");
}

function normalizeProof(proof: Uint8Array | string): string {
  return typeof proof === "string"
    ? proof
    : "0x" + Array.from(proof).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build a PoseidonMerkleTree from stored leaves (ascending leafIndex). */
export async function buildTree(
  leaves: Array<{ leafIndex: number; commitment: string }>,
): Promise<PoseidonMerkleTree> {
  const tree = new PoseidonMerkleTree(TREE_HEIGHT);
  for (const l of leaves) await tree.insert(BigInt(l.commitment), l.leafIndex);
  return tree;
}

// ── Shield (public → private note, to self) ─────────────────────────────

export type ShieldIntent = {
  to: string;
  data: string;
  value: string; // decimal wei
  chainId: number;
  leafCommitment: string;
  secret: string; // decimal
  encryptedPayload: string;
  /** ERC-20 token that must be approved for the router before the shield
   *  tx, or undefined for a native shield. */
  approveToken?: string;
  assetId: string; // 0x + 40 hex (token) or the ETH sentinel
  amount: string; // base units
};

export async function buildShield(args: {
  chainId: number;
  pampalo: string;
  amount: bigint;
  /** undefined / ETH sentinel → native shield. */
  asset?: string;
  ownerPoseidon: string;
  envelopePubKey: string;
}): Promise<ShieldIntent> {
  if (args.amount <= 0n) throw new Error("amount must be > 0");
  const native = isNativeAsset(args.asset);
  const assetId = native ? BigInt(ETH_SENTINEL) : BigInt(args.asset!);
  const owner = BigInt(args.ownerPoseidon);
  const secret = randomSecret();

  const leafBig = poseidon2Hash([assetId, args.amount, owner, secret]);
  const encryptedPayload = await NoteEncryption.encryptNoteData(
    { secret, owner, asset_id: assetId, asset_amount: args.amount },
    args.envelopePubKey,
  );

  const shield = new Shield();
  await shield.init();
  const { witness } = await shield.shieldNoir.execute({
    hash: leafBig.toString(),
    asset_id: assetId.toString(),
    asset_amount: args.amount.toString(),
    owner: owner.toString(),
    secret: secret.toString(),
  });
  const proof = await shield.shieldBackend.generateProof(witness, {
    keccakZK: true,
  });
  const proofBytes = normalizeProof(proof.proof);
  const publicInputs = proof.publicInputs as string[];

  const data = native
    ? SHIELD_NATIVE.encodeFunctionData("shieldNative", [
        proofBytes,
        publicInputs,
        encryptedPayload,
      ])
    : SHIELD_ERC20.encodeFunctionData("shield", [
        args.asset,
        args.amount,
        proofBytes,
        publicInputs,
        encryptedPayload,
      ]);

  return {
    to: args.pampalo,
    data,
    value: native ? args.amount.toString() : "0",
    chainId: args.chainId,
    leafCommitment: hex64(leafBig),
    secret: secret.toString(),
    encryptedPayload,
    approveToken: native ? undefined : args.asset!.toLowerCase(),
    assetId: native ? ETH_SENTINEL.toLowerCase() : args.asset!.toLowerCase(),
    amount: args.amount.toString(),
  };
}

// ── Transfer (private note → private note) ──────────────────────────────

export type TransferRecipient = {
  poseidonOwner: string;
  envelopePubKey: string;
  asset: string;
  amount: bigint;
};
export type TransferInputNote = {
  asset: string;
  amount: bigint;
  secret: string;
  owner: string;
  leafIndex: number;
};
export type OutputNote = {
  secret: string;
  owner: string;
  asset: string;
  amount: string;
  leafCommitment: string;
  encryptedPayload: string;
};
export type TransferIntent = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  outputs: OutputNote[];
  spentNullifiers: string[];
};

export async function buildTransfer(args: {
  chainId: number;
  pampalo: string;
  inputNotes: TransferInputNote[];
  outputs: TransferRecipient[];
  walletPrivateKey: string;
  tree: PoseidonMerkleTree;
}): Promise<TransferIntent> {
  const { inputNotes, outputs, tree } = args;
  if (inputNotes.length === 0 || inputNotes.length > NOTE_COUNT) {
    throw new Error(`inputNotes.length must be 1..${NOTE_COUNT}`);
  }
  if (outputs.length === 0 || outputs.length > NOTE_COUNT) {
    throw new Error(`outputs.length must be 1..${NOTE_COUNT}`);
  }
  assertBalanced(inputNotes, outputs);

  const ownerSecret = BigInt(args.walletPrivateKey) % POSEIDON_MAX;
  const root = await tree.getRoot();

  const circuitInputs: CircuitInput[] = [];
  const nullifiers: bigint[] = [];
  const spentNullifiers: string[] = [];
  for (const n of inputNotes) {
    const proof = await tree.getProof(n.leafIndex);
    if (proof.siblings.length !== TREE_HEIGHT - 1) {
      throw new Error(`bad merkle proof length for leaf ${n.leafIndex}`);
    }
    const nf = poseidon2Hash([
      BigInt(n.leafIndex),
      BigInt(n.owner),
      BigInt(n.secret),
      BigInt(n.asset),
      n.amount,
    ]);
    nullifiers.push(nf);
    spentNullifiers.push(nf.toString());
    circuitInputs.push({
      asset_id: BigInt(n.asset).toString(),
      asset_amount: n.amount.toString(),
      owner: BigInt(n.owner).toString(),
      owner_secret: ownerSecret.toString(),
      secret: BigInt(n.secret).toString(),
      leaf_index: n.leafIndex.toString(),
      path: proof.siblings.map(String),
      path_indices: proof.indices.map(String),
    });
  }
  padInputs(circuitInputs, nullifiers);

  const circuitOutputs: CircuitOutput[] = [];
  const outputHashes: bigint[] = [];
  const blobs: string[] = [];
  const bookkeeping: OutputNote[] = [];
  for (const o of outputs) {
    const secret = randomSecret();
    const assetId = BigInt(o.asset);
    const owner = BigInt(o.poseidonOwner);
    const leaf = poseidon2Hash([assetId, o.amount, owner, secret]);
    outputHashes.push(leaf);
    circuitOutputs.push({
      owner: owner.toString(),
      secret: secret.toString(),
      asset_id: assetId.toString(),
      asset_amount: o.amount.toString(),
    });
    const blob = await NoteEncryption.encryptNoteData(
      { secret, owner, asset_id: assetId, asset_amount: o.amount },
      o.envelopePubKey,
    );
    blobs.push(blob);
    bookkeeping.push({
      secret: secret.toString(),
      owner: hex64(owner),
      asset: o.asset.toLowerCase(),
      amount: o.amount.toString(),
      leafCommitment: hex64(leaf),
      encryptedPayload: blob,
    });
  }
  while (circuitOutputs.length < NOTE_COUNT) {
    circuitOutputs.push({ owner: "0", secret: "0", asset_id: "0", asset_amount: "0" });
    outputHashes.push(0n);
  }
  while (blobs.length < NOTE_COUNT) blobs.push("0x");

  const transfer = new Transfer();
  await transfer.init();
  const { witness } = await transfer.transferNoir.execute({
    root: root.toString(),
    input_notes: circuitInputs,
    output_notes: circuitOutputs,
    nullifiers: nullifiers.map(String),
    output_hashes: outputHashes.map(String),
  });
  const proof = await transfer.transferBackend.generateProof(witness, {
    keccakZK: true,
  });
  const data = TRANSFER.encodeFunctionData("transfer", [
    normalizeProof(proof.proof),
    proof.publicInputs as string[],
    blobs,
  ]);

  return {
    to: args.pampalo,
    data,
    value: "0",
    chainId: args.chainId,
    outputs: bookkeeping,
    spentNullifiers,
  };
}

// ── Unshield (private note → public payout + optional change) ────────────

export type UnshieldIntent = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  spentNullifier: string;
  changeOutput?: OutputNote;
  exit: { asset: string; amount: string; address: string };
};

export async function buildUnshield(args: {
  chainId: number;
  pampalo: string;
  inputNote: TransferInputNote;
  exitAddress: string;
  exitAmount: bigint;
  walletPrivateKey: string;
  selfPoseidon: string;
  selfEnvelopePubKey: string;
  tree: PoseidonMerkleTree;
}): Promise<UnshieldIntent> {
  const { inputNote, exitAmount, tree } = args;
  if (exitAmount <= 0n) throw new Error("exitAmount must be > 0");
  if (exitAmount > inputNote.amount) {
    throw new Error("exitAmount exceeds input note amount");
  }
  const changeAmount = inputNote.amount - exitAmount;
  const ownerSecret = BigInt(args.walletPrivateKey) % POSEIDON_MAX;

  const assetId = BigInt(inputNote.asset);
  const root = await tree.getRoot();
  const proof = await tree.getProof(inputNote.leafIndex);
  if (proof.siblings.length !== TREE_HEIGHT - 1) {
    throw new Error(`bad merkle proof length for leaf ${inputNote.leafIndex}`);
  }
  const nullifier = poseidon2Hash([
    BigInt(inputNote.leafIndex),
    BigInt(inputNote.owner),
    BigInt(inputNote.secret),
    assetId,
    inputNote.amount,
  ]);

  const circuitInputs: CircuitInput[] = [
    {
      asset_id: assetId.toString(),
      asset_amount: inputNote.amount.toString(),
      owner: BigInt(inputNote.owner).toString(),
      owner_secret: ownerSecret.toString(),
      secret: BigInt(inputNote.secret).toString(),
      leaf_index: inputNote.leafIndex.toString(),
      path: proof.siblings.map(String),
      path_indices: proof.indices.map(String),
    },
  ];
  const dummyNulls: bigint[] = [];
  padInputs(circuitInputs, dummyNulls);
  const nullifiers: bigint[] = [nullifier, 0n, 0n];

  const exitAddrBig = BigInt(args.exitAddress);
  const circuitOutputs: ExitOutput[] = [];
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
    asset_id: assetId.toString(),
    asset_amount: exitAmount.toString(),
    external_address: exitAddrBig.toString(),
  });
  outputHashes.push(0n);
  exitAssets.push(assetId);
  exitAmounts.push(exitAmount);
  exitAddresses.push(exitAddrBig);
  exitAddressHashes.push(poseidon2Hash([exitAddrBig]));
  payloads.push("0x");

  let changeOutput: OutputNote | undefined;
  if (changeAmount > 0n) {
    const secret = randomSecret();
    const owner = BigInt(args.selfPoseidon);
    const leaf = poseidon2Hash([assetId, changeAmount, owner, secret]);
    circuitOutputs.push({
      owner: owner.toString(),
      secret: secret.toString(),
      asset_id: assetId.toString(),
      asset_amount: changeAmount.toString(),
      external_address: "0",
    });
    outputHashes.push(leaf);
    exitAssets.push(0n);
    exitAmounts.push(0n);
    exitAddresses.push(0n);
    exitAddressHashes.push(0n);
    const blob = await NoteEncryption.encryptNoteData(
      { secret, owner, asset_id: assetId, asset_amount: changeAmount },
      args.selfEnvelopePubKey,
    );
    payloads.push(blob);
    changeOutput = {
      secret: secret.toString(),
      owner: hex64(owner),
      asset: inputNote.asset.toLowerCase(),
      amount: changeAmount.toString(),
      leafCommitment: hex64(leaf),
      encryptedPayload: blob,
    };
  }
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

  const ub = new UnshieldBundled();
  await ub.init();
  const { witness } = await ub.unshieldBundledNoir.execute({
    root: root.toString(),
    input_notes: circuitInputs,
    output_notes: circuitOutputs,
    nullifiers: nullifiers.map(String),
    output_hashes: outputHashes.map(String),
    exit_assets: exitAssets.map(String),
    exit_amounts: exitAmounts.map(String),
    exit_addresses: exitAddresses.map(String),
    exit_address_hashes: exitAddressHashes.map(String),
  });
  const proofGen = await ub.unshieldBundledBackend.generateProof(witness, {
    keccakZK: true,
  });
  const data = UNSHIELD_BUNDLED.encodeFunctionData("unshieldBundled", [
    normalizeProof(proofGen.proof),
    proofGen.publicInputs as string[],
    payloads,
  ]);

  return {
    to: args.pampalo,
    data,
    value: "0",
    chainId: args.chainId,
    spentNullifier: nullifier.toString(),
    changeOutput,
    exit: {
      asset: inputNote.asset.toLowerCase(),
      amount: exitAmount.toString(),
      address: args.exitAddress.toLowerCase(),
    },
  };
}

// ── Private swap (note A → note B against public Uniswap liquidity) ──────

export type PrivateSwapIntent = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  /** The fixed-output asset-B note minted at T (owner = self). */
  outputNote: OutputNote;
  /** The same-asset asset-A change note, when inputs exceed inputAmount. */
  changeOutput?: OutputNote;
  spentNullifiers: string[];
};

export async function buildPrivateSwap(args: {
  chainId: number;
  pampalo: string;
  /** asset-A notes to spend; all must be `inputAsset`. */
  inputNotes: TransferInputNote[];
  /** asset-A amount sent into the pool (<= sum of inputNotes). */
  inputAmount: bigint;
  /** asset-B token the swap outputs. */
  outputAsset: string;
  /** B-note amount + slippage/sandwich floor T (ADR 0020). */
  targetOutput: bigint;
  /** Opaque venue route: v4 abi.encode(Hop[]) or a v3 packed path. */
  route: string;
  /** Owner of the minted B note + change note (this wallet). */
  selfPoseidon: string;
  selfEnvelopePubKey: string;
  walletPrivateKey: string;
  tree: PoseidonMerkleTree;
}): Promise<PrivateSwapIntent> {
  const { inputNotes, inputAmount, targetOutput, tree } = args;
  if (inputNotes.length === 0 || inputNotes.length > NOTE_COUNT) {
    throw new Error(`inputNotes.length must be 1..${NOTE_COUNT}`);
  }
  if (inputAmount <= 0n) throw new Error("inputAmount must be > 0");
  if (targetOutput <= 0n) throw new Error("targetOutput must be > 0");

  const inputAsset = inputNotes[0].asset.toLowerCase();
  let inSum = 0n;
  for (const n of inputNotes) {
    if (n.asset.toLowerCase() !== inputAsset) {
      throw new Error("all input notes must share one asset");
    }
    inSum += n.amount;
  }
  if (inputAmount > inSum) throw new Error("inputAmount exceeds notes total");
  const changeAmount = inSum - inputAmount;

  const ownerSecret = BigInt(args.walletPrivateKey) % POSEIDON_MAX;
  const root = await tree.getRoot();
  const inputAssetBig = BigInt(inputAsset);
  const outputAssetBig = BigInt(args.outputAsset);

  // Spent input notes → nullifiers + circuit witnesses.
  const circuitInputs: CircuitInput[] = [];
  const nullifiers: bigint[] = [];
  const spentNullifiers: string[] = [];
  for (const n of inputNotes) {
    const proof = await tree.getProof(n.leafIndex);
    if (proof.siblings.length !== TREE_HEIGHT - 1) {
      throw new Error(`bad merkle proof length for leaf ${n.leafIndex}`);
    }
    const nf = poseidon2Hash([
      BigInt(n.leafIndex),
      BigInt(n.owner),
      BigInt(n.secret),
      BigInt(n.asset),
      n.amount,
    ]);
    nullifiers.push(nf);
    spentNullifiers.push(nf.toString());
    circuitInputs.push({
      asset_id: BigInt(n.asset).toString(),
      asset_amount: n.amount.toString(),
      owner: BigInt(n.owner).toString(),
      owner_secret: ownerSecret.toString(),
      secret: BigInt(n.secret).toString(),
      leaf_index: n.leafIndex.toString(),
      path: proof.siblings.map(String),
      path_indices: proof.indices.map(String),
    });
  }
  padInputs(circuitInputs, nullifiers);

  const owner = BigInt(args.selfPoseidon);

  // Output B note @ T (committed in-circuit; the realized amount is never
  // seen — the contract enforces realized >= T and forfeits the surplus).
  const swapSecret = randomSecret();
  const swapLeaf = poseidon2Hash([outputAssetBig, targetOutput, owner, swapSecret]);
  const swapBlob = await NoteEncryption.encryptNoteData(
    { secret: swapSecret, owner, asset_id: outputAssetBig, asset_amount: targetOutput },
    args.selfEnvelopePubKey,
  );
  const outputNote: OutputNote = {
    secret: swapSecret.toString(),
    owner: hex64(owner),
    asset: args.outputAsset.toLowerCase(),
    amount: targetOutput.toString(),
    leafCommitment: hex64(swapLeaf),
    encryptedPayload: swapBlob,
  };

  // Optional same-asset (asset-A) change note.
  let changeLeaf = 0n;
  let changeSecret = 0n;
  let changeBlob = "0x";
  let changeOutput: OutputNote | undefined;
  if (changeAmount > 0n) {
    changeSecret = randomSecret();
    changeLeaf = poseidon2Hash([inputAssetBig, changeAmount, owner, changeSecret]);
    changeBlob = await NoteEncryption.encryptNoteData(
      { secret: changeSecret, owner, asset_id: inputAssetBig, asset_amount: changeAmount },
      args.selfEnvelopePubKey,
    );
    changeOutput = {
      secret: changeSecret.toString(),
      owner: hex64(owner),
      asset: inputAsset,
      amount: changeAmount.toString(),
      leafCommitment: hex64(changeLeaf),
      encryptedPayload: changeBlob,
    };
  }

  const outputHashes = [swapLeaf, changeLeaf, 0n];
  const blobs = [swapBlob, changeBlob, "0x"];

  const swap = new Swap();
  await swap.init();
  const { witness } = await swap.swapNoir.execute({
    root: root.toString(),
    input_notes: circuitInputs,
    nullifiers: nullifiers.map(String),
    output_hashes: outputHashes.map(String),
    input_asset: inputAssetBig.toString(),
    input_amount: inputAmount.toString(),
    output_asset: outputAssetBig.toString(),
    target_output: targetOutput.toString(),
    swap_output_owner: owner.toString(),
    swap_output_secret: swapSecret.toString(),
    change_amount: changeAmount.toString(),
    change_owner: changeAmount > 0n ? owner.toString() : "0",
    change_secret: changeAmount > 0n ? changeSecret.toString() : "0",
  });
  const proof = await swap.swapBackend.generateProof(witness, {
    keccakZK: true,
  });

  const data = PRIVATE_SWAP.encodeFunctionData("privateSwap", [
    normalizeProof(proof.proof),
    proof.publicInputs as string[],
    args.route,
    blobs,
  ]);

  return {
    to: args.pampalo,
    data,
    value: "0",
    chainId: args.chainId,
    outputNote,
    changeOutput,
    spentNullifiers,
  };
}

// ── shared witness types + helpers ──────────────────────────────────────

type CircuitInput = {
  asset_id: string;
  asset_amount: string;
  owner: string;
  owner_secret: string;
  secret: string;
  leaf_index: string;
  path: string[];
  path_indices: string[];
};
type CircuitOutput = {
  owner: string;
  secret: string;
  asset_id: string;
  asset_amount: string;
};
type ExitOutput = CircuitOutput & { external_address: string };

function emptyInput(): CircuitInput {
  return {
    asset_id: "0",
    asset_amount: "0",
    owner: "0",
    owner_secret: "0",
    secret: "0",
    leaf_index: "0",
    path: new Array<string>(TREE_HEIGHT - 1).fill("0"),
    path_indices: new Array<string>(TREE_HEIGHT - 1).fill("0"),
  };
}

function padInputs(inputs: CircuitInput[], nullifiers: bigint[]): void {
  while (inputs.length < NOTE_COUNT) {
    inputs.push(emptyInput());
    nullifiers.push(0n);
  }
}

function assertBalanced(
  inputs: TransferInputNote[],
  outputs: TransferRecipient[],
): void {
  const inSum = new Map<string, bigint>();
  const outSum = new Map<string, bigint>();
  for (const n of inputs) {
    const a = n.asset.toLowerCase();
    inSum.set(a, (inSum.get(a) ?? 0n) + n.amount);
  }
  for (const o of outputs) {
    const a = o.asset.toLowerCase();
    outSum.set(a, (outSum.get(a) ?? 0n) + o.amount);
  }
  for (const [asset, sumIn] of inSum) {
    if ((outSum.get(asset) ?? 0n) !== sumIn) {
      throw new Error(`transfer unbalanced for asset ${asset}`);
    }
  }
  for (const asset of outSum.keys()) {
    if (!inSum.has(asset)) throw new Error(`output-only asset ${asset}`);
  }
}

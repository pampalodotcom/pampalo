// Pure helpers for preparing a private `privateSwap` transaction
// (ADR 0020). Mirrors `transfer-prep.ts`: lazy-loads the heavy proof-gen
// + ECIES deps, exposes `warmSwap()` for idle warmup, and returns a
// fully prepared unsigned-tx envelope the caller drops into
// `signTransactionWithPasskey` (self-broadcast) or `rpc.relay({kind:
// "swap"})`.
//
// A private swap spends asset-A note(s), trades `inputAmount` against
// public Uniswap liquidity, and mints a FIXED-OUTPUT asset-B note at the
// target `T` (committed in-circuit; the realized amount is enforced
// on-chain as `realized >= T`, surplus forfeited) plus an optional
// same-asset asset-A change note. Both minted notes are owned by this
// wallet.
//
// Public-input layout the contract reads positionally (see
// `PampaloSwapBase.privateSwap`):
//
//   publicInputs[0]       = root
//   publicInputs[1..3]    = nullifiers per input slot
//   publicInputs[4..6]    = output commitments ([4]=B@T, [5]=change, [6]=0)
//   publicInputs[7]       = input_asset
//   publicInputs[8]       = input_amount
//   publicInputs[9]       = output_asset
//   publicInputs[10]      = target_output (T)

import { Interface } from "ethers";
import { POSEIDON_MAX } from "./derive-addresses";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";

const PRIVATE_SWAP_IFACE = new Interface([
  "function privateSwap(bytes proof, bytes32[] publicInputs, bytes route, bytes[] payload) external",
]);

// Matches the swap circuit's `NOTE_COUNT` global.
const NOTE_COUNT = 3;

export type SwapInputNote = {
  /** Lowercased asset address (asset A). */
  asset: string;
  amount: bigint;
  secret: string;
  owner: string;
  leafIndex: number;
};

export type SwapInput = {
  chainId: number;
  /** Lowercased PampaloSwapV3/V4 router address on `chainId`. */
  pampaloAddress: string;

  /** 1..NOTE_COUNT asset-A notes to spend (all the same asset). */
  inputNotes: SwapInputNote[];
  /** asset-A amount sent into the pool (<= sum of inputNotes). */
  inputAmount: bigint;
  /** asset-B token address (lowercased). */
  outputAsset: string;
  /** B-note amount + slippage/sandwich floor (T). */
  targetOutput: bigint;
  /** Opaque venue route bytes (see `encodeV3Path`). */
  route: string;

  /** This wallet's Poseidon owner (0x + 64 hex) — owns both minted notes. */
  selfPoseidon: string;
  /** This wallet's envelope (ECIES) public key. */
  selfEnvelopePubKey: string;
  /** This wallet's EVM private key (drives the input's `owner_secret`). */
  walletPrivateKey: string;

  /** Pre-built merkle tree of every executed leaf on this chain. */
  tree: PoseidonMerkleTreeType;
};

export type PreparedSwapNote = {
  secret: string;
  owner: string;
  asset: string;
  amount: string;
  leafCommitment: string;
  encryptedPayload: string;
};

export type PreparedSwapTx = {
  to: string;
  data: string;
  value: string; // always "0"
  chainId: number;

  proofBytes: string;
  publicInputs: readonly string[];
  route: string;
  payload: readonly string[]; // [B blob, change blob | "0x", "0x"]

  /** The minted asset-B note (owned by self → spendable on confirm). */
  outputNote: PreparedSwapNote;
  /** The same-asset change note, when inputs exceed inputAmount. */
  changeNote?: PreparedSwapNote;
  /** Decimal-string nullifiers for each spent input note, in order. */
  spentNullifiers: string[];
};

// ─── v3 route builder ────────────────────────────────────────────────────

/** Uniswap v3 packed path: token0 || fee0 || token1 [ || fee1 || token2 … ].
 *  `tokens.length` must be `fees.length + 1`. */
export function encodeV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) {
    throw new Error("encodeV3Path: tokens.length must equal fees.length + 1");
  }
  let path = "0x";
  for (let i = 0; i < fees.length; i++) {
    path += tokens[i].toLowerCase().replace(/^0x/, "");
    path += fees[i].toString(16).padStart(6, "0");
  }
  path += tokens[tokens.length - 1].toLowerCase().replace(/^0x/, "");
  return path;
}

// ─── warmup ──────────────────────────────────────────────────────────────

type WarmModules = {
  Swap: unknown;
  NoteEncryption: unknown;
  poseidon2Hash: unknown;
};

let _warmPromise: Promise<WarmModules> | null = null;

async function loadModules(): Promise<WarmModules> {
  const [swapMod, noteMod, poseidonMod] = await Promise.all([
    import("@pampalo/shared/classes/Swap"),
    import("@pampalo/shared/classes/Note"),
    import("@zkpassport/poseidon2"),
  ]);
  return {
    Swap: swapMod.Swap,
    NoteEncryption: noteMod.NoteEncryption,
    poseidon2Hash: poseidonMod.poseidon2Hash,
  };
}

export function warmSwap(): Promise<void> {
  if (!_warmPromise) _warmPromise = loadModules();
  return _warmPromise.then(async (mods) => {
    type SwapCtor = new () => { init: () => Promise<void> };
    const swap = new (mods.Swap as SwapCtor)();
    await swap.init();
  });
}

async function getWarmModules(): Promise<WarmModules> {
  if (!_warmPromise) _warmPromise = loadModules();
  return await _warmPromise;
}

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

// ─── prepare ───────────────────────────────────────────────────────────────

export async function prepareSwap(input: SwapInput): Promise<PreparedSwapTx> {
  const {
    chainId,
    pampaloAddress,
    inputNotes,
    inputAmount,
    outputAsset,
    targetOutput,
    route,
    selfPoseidon,
    selfEnvelopePubKey,
    walletPrivateKey,
    tree,
  } = input;

  if (inputNotes.length === 0 || inputNotes.length > NOTE_COUNT) {
    throw new Error(`inputNotes.length must be 1..${NOTE_COUNT}`);
  }
  if (inputAmount <= 0n) throw new Error("inputAmount must be > 0");
  if (targetOutput <= 0n) throw new Error("targetOutput must be > 0");

  const inputAsset = inputNotes[0].asset.toLowerCase();
  let inSum = 0n;
  for (const n of inputNotes) {
    if (n.asset.toLowerCase() !== inputAsset) {
      throw new Error("swap-prep: all input notes must share one asset");
    }
    inSum += n.amount;
  }
  if (inputAmount > inSum) {
    throw new Error(
      `swap-prep: inputAmount ${inputAmount} exceeds notes total ${inSum}`,
    );
  }
  const changeAmount = inSum - inputAmount;

  const mods = await getWarmModules();
  type SwapCtor = new () => {
    init: () => Promise<void>;
    swapNoir: {
      execute: (
        witness: Record<string, unknown>,
      ) => Promise<{ witness: Uint8Array }>;
    };
    swapBackend: {
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
  const Swap = mods.Swap as SwapCtor;
  const NoteEncryption = mods.NoteEncryption as NoteEncryptionStatic;
  const poseidon2Hash = mods.poseidon2Hash as (xs: bigint[]) => bigint;

  const ownerSecret = BigInt(walletPrivateKey) % POSEIDON_MAX;
  const inputAssetBig = BigInt(inputAsset);
  const outputAssetBig = BigInt(outputAsset);
  const owner = BigInt(selfPoseidon);
  const root = await tree.getRoot();

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

  const circuitInputs: CircuitInputNote[] = [];
  const nullifiers: bigint[] = [];
  const spentNullifiers: string[] = [];

  for (const n of inputNotes) {
    const proof = await tree.getProof(n.leafIndex);
    if (proof.siblings.length !== 11 || proof.indices.length !== 11) {
      throw new Error(
        `swap-prep: merkle proof has wrong length for leaf ${n.leafIndex}`,
      );
    }
    const nullifier = poseidon2Hash([
      BigInt(n.leafIndex),
      BigInt(n.owner),
      BigInt(n.secret),
      BigInt(n.asset),
      n.amount,
    ]);
    nullifiers.push(nullifier);
    spentNullifiers.push(nullifier.toString());
    circuitInputs.push({
      asset_id: BigInt(n.asset).toString(),
      asset_amount: n.amount.toString(),
      owner: BigInt(n.owner).toString(),
      owner_secret: ownerSecret.toString(),
      secret: BigInt(n.secret).toString(),
      leaf_index: n.leafIndex.toString(),
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

  // Output B note @ T.
  const swapSecret = randomSecret();
  const swapLeaf = poseidon2Hash([
    outputAssetBig,
    targetOutput,
    owner,
    swapSecret,
  ]);
  const swapBlob = await NoteEncryption.encryptNoteData(
    {
      secret: swapSecret,
      owner,
      asset_id: outputAssetBig,
      asset_amount: targetOutput,
    },
    selfEnvelopePubKey,
  );
  const outputNote: PreparedSwapNote = {
    secret: swapSecret.toString(),
    owner: "0x" + owner.toString(16).padStart(64, "0"),
    asset: outputAsset.toLowerCase(),
    amount: targetOutput.toString(),
    leafCommitment: "0x" + swapLeaf.toString(16).padStart(64, "0"),
    encryptedPayload: swapBlob,
  };

  // Optional asset-A change note.
  let changeLeaf = 0n;
  let changeSecret = 0n;
  let changeBlob = "0x";
  let changeNote: PreparedSwapNote | undefined;
  if (changeAmount > 0n) {
    changeSecret = randomSecret();
    changeLeaf = poseidon2Hash([
      inputAssetBig,
      changeAmount,
      owner,
      changeSecret,
    ]);
    changeBlob = await NoteEncryption.encryptNoteData(
      {
        secret: changeSecret,
        owner,
        asset_id: inputAssetBig,
        asset_amount: changeAmount,
      },
      selfEnvelopePubKey,
    );
    changeNote = {
      secret: changeSecret.toString(),
      owner: "0x" + owner.toString(16).padStart(64, "0"),
      asset: inputAsset,
      amount: changeAmount.toString(),
      leafCommitment: "0x" + changeLeaf.toString(16).padStart(64, "0"),
      encryptedPayload: changeBlob,
    };
  }

  const outputHashes = [swapLeaf, changeLeaf, 0n];
  const ecieBlobs = [swapBlob, changeBlob, "0x"];

  const swap = new Swap();
  await swap.init();
  const { witness } = await swap.swapNoir.execute({
    root: root.toString(),
    input_notes: circuitInputs as unknown,
    nullifiers: nullifiers.map((n) => n.toString()),
    output_hashes: outputHashes.map((h) => h.toString()),
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

  const data = PRIVATE_SWAP_IFACE.encodeFunctionData("privateSwap", [
    proofBytes,
    publicInputs,
    route,
    ecieBlobs,
  ]);

  return {
    to: pampaloAddress,
    data,
    value: "0",
    chainId,
    proofBytes,
    publicInputs,
    route,
    payload: ecieBlobs,
    outputNote,
    changeNote,
    spentNullifiers,
  };
}

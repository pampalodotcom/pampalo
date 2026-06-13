import type { InputNote } from "@pampalo/shared/types/notes";
import { Swap } from "@pampalo/shared/classes/Swap";
import type { ProofData } from "@aztec/bb.js";
import { ethers } from "ethers";
import { PoseidonMerkleTree } from "@/helpers/objects/poseidon-merkle-tree.js";
import { encodeEncryptedPayload } from "./transfer.js";
import type { EncryptedNote } from "../note-sharing.js";

// Witness + proof generator for the `swap` circuit (ADR 0020). Spends
// asset-A input notes via nullifier, mints a fixed-output asset-B note
// at `targetOutput` plus an optional same-asset change note. The
// realized AMM output is never seen by the circuit — the contract
// enforces `realized >= targetOutput` on-chain.

export type SwapWitnessParams = {
  inputAsset: bigint | string;
  inputAmount: bigint | string;
  outputAsset: bigint | string;
  targetOutput: bigint | string;
  swapOutputOwner: bigint | string;
  swapOutputSecret: bigint | string;
  changeAmount: bigint | string;
  changeOwner: bigint | string;
  changeSecret: bigint | string;
};

export const getSwapDetails = async (
  tree: PoseidonMerkleTree,
  inputNotes: InputNote[],
  nullifiers: (bigint | string)[],
  outputHashes: (bigint | string)[],
  params: SwapWitnessParams,
) => {
  const swap = new Swap();
  await swap.init();

  const root = await tree.getRoot();

  const { witness } = await swap.swapNoir.execute({
    root: root.toString(),
    input_notes: inputNotes as never,
    nullifiers: nullifiers.map((item) => BigInt(item).toString()),
    output_hashes: outputHashes.map((item) => BigInt(item).toString()),
    input_asset: BigInt(params.inputAsset).toString(),
    input_amount: BigInt(params.inputAmount).toString(),
    output_asset: BigInt(params.outputAsset).toString(),
    target_output: BigInt(params.targetOutput).toString(),
    swap_output_owner: BigInt(params.swapOutputOwner).toString(),
    swap_output_secret: BigInt(params.swapOutputSecret).toString(),
    change_amount: BigInt(params.changeAmount).toString(),
    change_owner: BigInt(params.changeOwner).toString(),
    change_secret: BigInt(params.changeSecret).toString(),
  });

  const proof = await swap.swapBackend.generateProof(witness, {
    keccakZK: true,
  });

  return { proof };
};

// Submit a swap proof to a PampaloSwapV4 / PampaloSwapV3 contract.
// `route` is the venue route bytes (see the encoders below).

export const privateSwap = async (
  contract: ethers.Contract,
  proof: ProofData,
  route: string,
  runner: ethers.Signer,
  encryptedNotes?: (EncryptedNote | "0x")[],
) => {
  const payload = encodeEncryptedPayload(encryptedNotes ?? []);

  return await contract.connect(runner).getFunction("privateSwap")(
    proof.proof,
    proof.publicInputs,
    route,
    payload,
  );
};

// ─── Route encoders ─────────────────────────────────────────────────────

// Uniswap v3 packed path: token0 || fee0 || token1 [ || fee1 || token2 … ].
// `tokens.length` must be `fees.length + 1`.
export const encodeV3Path = (tokens: string[], fees: number[]): string => {
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
};

export type V4PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

export type V4Hop = {
  key: V4PoolKey;
  zeroForOne: boolean;
};

const V4_HOP_TUPLE =
  "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne)[]";

// Uniswap v4 route: abi.encode(Hop[]). Matches PampaloSwapV4.SwapJob.hops.
export const encodeV4Route = (hops: V4Hop[]): string => {
  return ethers.AbiCoder.defaultAbiCoder().encode([V4_HOP_TUPLE], [hops]);
};

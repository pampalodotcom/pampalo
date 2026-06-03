import type { InputNote, OutputNote } from "@pampalo/shared/types/notes";
import { Transfer } from "@pampalo/shared/classes/Transfer";
import { UnshieldBundled } from "@pampalo/shared/classes/UnshieldBundled";
import type { ProofData } from "@aztec/bb.js";
import { ethers } from "ethers";
import { PoseidonMerkleTree } from "@/helpers/objects/poseidon-merkle-tree.js";
import { NoteEncryption, type EncryptedNote } from "../note-sharing.js";

// Witness + proof generator for the `transfer` circuit. Inputs are
// existing notes spent via nullifier; outputs are fresh leaves the
// caller is inserting.

export const getTransferDetails = async (
  tree: PoseidonMerkleTree,
  inputNotes: InputNote[],
  nullifiers: bigint[],
  outputNotes: OutputNote[],
  outputHashes: bigint[],
) => {
  const transfer = new Transfer();
  await transfer.init();

  const root = await tree.getRoot();

  const { witness } = await transfer.transferNoir.execute({
    root: root.toString(),
    input_notes: inputNotes as never,
    output_notes: outputNotes as never,
    nullifiers: nullifiers.map((item) => item.toString()),
    output_hashes: outputHashes.map((item) => item.toString()),
  });

  const proof = await transfer.transferBackend.generateProof(witness, {
    keccakZK: true,
  });

  return { proof };
};

// Submit a transfer proof to the Pampalo contract. `encryptedNotes`
// is optional and, when supplied, gets ABI-encoded into the bytes[]
// payload the contract re-emits as `NotePayload`.

export const transfer = async (
  pampalo: ethers.Contract,
  proof: ProofData,
  runner: ethers.Signer,
  encryptedNotes?: (EncryptedNote | "0x")[],
) => {
  const payload = encodeEncryptedPayload(encryptedNotes ?? []);

  return await pampalo.connect(runner).getFunction("transfer")(
    proof.proof,
    proof.publicInputs,
    payload,
  );
};

export const encodeEncryptedPayload = (
  encryptedNotes: (EncryptedNote | "0x")[],
): string[] => {
  const payload: string[] = [];

  for (const note of encryptedNotes) {
    if (note === "0x" || !note) {
      payload.push("0x");
    } else {
      const encodedNote = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "string", "string"],
        [note.encryptedSecret, note.owner, note.asset_id, note.asset_amount],
      );
      payload.push(encodedNote);
    }
  }

  return payload;
};

// Build the NotePayload bytes array for a shield. The shield circuit
// emits one output note (the new leaf), so only the first slot is
// populated and the other two are empty.

export const createShieldPayload = async (
  outputNote: {
    secret: string | bigint;
    owner: string;
    asset_id: string;
    asset_amount: string;
  },
  recipientSigner: ethers.Signer,
): Promise<string[]> => {
  const encryptedNote = await NoteEncryption.createEncryptedNote(
    outputNote,
    recipientSigner,
  );

  return encodeEncryptedPayload([encryptedNote, "0x", "0x"]);
};

// Witness + proof generator for the `unshieldBundled` circuit. Bundles
// up to 3 internal transfer outputs with up to 3 external exits in a
// single proof.

export const getUnshieldBundledDetails = async (
  tree: PoseidonMerkleTree,
  inputNotes: InputNote[],
  nullifiers: (bigint | string)[],
  outputNotes: OutputNote[],
  outputHashes: (bigint | string)[],
  exitAssets: (bigint | string)[],
  exitAmounts: (bigint | string)[],
  exitAddresses: (bigint | string)[],
  exitAddressHashes: (bigint | string)[],
) => {
  const unshieldBundled = new UnshieldBundled();
  await unshieldBundled.init();

  const root = await tree.getRoot();

  const { witness } = await unshieldBundled.unshieldBundledNoir.execute({
    root: root.toString(),
    input_notes: inputNotes as never,
    output_notes: outputNotes as never,
    nullifiers: nullifiers.map((item) => item.toString()),
    output_hashes: outputHashes.map((item) => item.toString()),
    exit_assets: exitAssets.map((item) => item.toString()),
    exit_amounts: exitAmounts.map((item) => item.toString()),
    exit_addresses: exitAddresses.map((item) => item.toString()),
    exit_address_hashes: exitAddressHashes.map((item) => item.toString()),
  });

  const proof = await unshieldBundled.unshieldBundledBackend.generateProof(
    witness,
    {
      keccakZK: true,
    },
  );

  return { proof };
};

// Submit an unshieldBundled proof to the Pampalo contract.

export const unshieldBundled = async (
  pampalo: ethers.Contract,
  proof: ProofData,
  runner: ethers.Signer,
  encryptedNotes?: (EncryptedNote | "0x")[],
) => {
  const payload = encodeEncryptedPayload(encryptedNotes ?? []);

  return await pampalo.connect(runner).getFunction("unshieldBundled")(
    proof.proof,
    proof.publicInputs,
    payload,
  );
};

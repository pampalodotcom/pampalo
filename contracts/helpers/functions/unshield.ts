import type { InputNote } from "@pampalo/shared/types/notes";
import { Unshield } from "@pampalo/shared/classes/Unshield";
import { PoseidonMerkleTree } from "@/helpers/objects/poseidon-merkle-tree.js";

// Witness + proof generator for the `unshield` circuit. Single-
// recipient unshield (as opposed to `unshieldBundled`, which mixes
// internal outputs and external payouts in one proof).

export const getUnshieldDetails = async (
  tree: PoseidonMerkleTree,
  inputNotes: InputNote[],
  nullifiers: string[],
  exitAssets: string[],
  exitAmounts: string[],
  exitAddresses: string[],
  exitAddressHashes: string[],
) => {
  const unshield = new Unshield();
  await unshield.init();

  const root = await tree.getRoot();

  const { witness } = await unshield.unshieldNoir.execute({
    root: "0x" + BigInt(root.toString()).toString(16),
    input_notes: inputNotes as never,
    nullifiers: nullifiers as never,
    exit_assets: exitAssets as never,
    exit_amounts: exitAmounts as never,
    exit_addresses: exitAddresses as never,
    exit_address_hashes: exitAddressHashes as never,
  });

  const proof = await unshield.unshieldBackend.generateProof(witness, {
    keccakZK: true,
  });

  return { proof };
};

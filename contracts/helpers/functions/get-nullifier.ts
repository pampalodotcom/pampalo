import type { InputNote } from "@pampalo/shared/types/notes";
import { poseidon2Hash } from "@zkpassport/poseidon2";

// Recomputes the nullifier the transfer / unshield / unshieldBundled
// circuits emit when spending an input note. Tests compare emitted
// `NullifierUsed` events against this to confirm the contract is
// reading the right slot of `_publicInputs`.

export async function getNullifier(note: InputNote): Promise<bigint>;
export async function getNullifier(
  leafIndex: bigint | string,
  owner: bigint | string,
  secret: bigint | string,
  assetId: bigint | string,
  amount: bigint | string,
): Promise<bigint>;

export async function getNullifier(
  leafIndexOrNote: bigint | string | InputNote,
  owner?: bigint | string,
  secret?: bigint | string,
  assetId?: bigint | string,
  amount?: bigint | string,
): Promise<bigint> {
  let leafIndex: bigint | string;
  let noteOwner: bigint | string;
  let noteSecret: bigint | string;
  let noteAssetId: bigint | string;
  let noteAmount: bigint | string;

  if (
    typeof leafIndexOrNote === "object" &&
    leafIndexOrNote !== null &&
    "leaf_index" in leafIndexOrNote
  ) {
    const note = leafIndexOrNote as InputNote;
    leafIndex = note.leaf_index;
    noteOwner = note.owner;
    noteSecret = note.secret;
    noteAssetId = note.asset_id;
    noteAmount = note.asset_amount;
  } else {
    if (
      owner === undefined ||
      secret === undefined ||
      assetId === undefined ||
      amount === undefined
    ) {
      throw new Error(
        "Missing required parameters when not passing an InputNote object",
      );
    }
    leafIndex = leafIndexOrNote as bigint | string;
    noteOwner = owner;
    noteSecret = secret;
    noteAssetId = assetId;
    noteAmount = amount;
  }

  const nullifier = poseidon2Hash([
    BigInt(leafIndex),
    BigInt(noteOwner),
    BigInt(noteSecret),
    BigInt(noteAssetId),
    BigInt(noteAmount),
  ]);

  return BigInt(nullifier.toString());
}

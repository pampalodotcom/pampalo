import type { OutputNote } from "@pampalo/shared/types/notes";
import { poseidon2Hash } from "@zkpassport/poseidon2";

// Recomputes a leaf hash for an OutputNote — the same hash the
// shield circuit asserts. Used by tests to confirm that the public
// input the contract receives matches the off-chain mirror.

export async function getNoteHash(note: OutputNote): Promise<bigint>;
export async function getNoteHash(
  owner: bigint | string,
  secret: bigint | string,
  assetId: bigint | string,
  amount: bigint | string,
): Promise<bigint>;

export async function getNoteHash(
  ownerOrNote: bigint | string | OutputNote,
  secret?: bigint | string,
  assetId?: bigint | string,
  amount?: bigint | string,
): Promise<bigint> {
  let owner: bigint | string;
  let noteSecret: bigint | string;
  let noteAssetId: bigint | string;
  let noteAmount: bigint | string;

  if (
    typeof ownerOrNote === "object" &&
    ownerOrNote !== null &&
    "owner" in ownerOrNote
  ) {
    const note = ownerOrNote as OutputNote;
    owner = note.owner;
    noteSecret = note.secret;
    noteAssetId = note.asset_id;
    noteAmount = note.asset_amount;
  } else {
    if (secret === undefined || assetId === undefined || amount === undefined) {
      throw new Error(
        "Missing required parameters when not passing an OutputNote object",
      );
    }
    owner = ownerOrNote as bigint | string;
    noteSecret = secret;
    noteAssetId = assetId;
    noteAmount = amount;
  }

  const noteHash = poseidon2Hash([
    BigInt(noteAssetId),
    BigInt(noteAmount),
    BigInt(owner),
    BigInt(noteSecret),
  ]);

  return BigInt(noteHash.toString());
}

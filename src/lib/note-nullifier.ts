import { poseidon2Hash } from "@zkpassport/poseidon2";

// A note's on-chain nullifier as a lowercased bytes32 hex string.
//
// Matches Pampalo's circuit + contract exactly (see transfer-prep.ts and
// Pampalo.sol's `nullifierUsed`):
//
//   nullifier = poseidon2([leaf_index, owner, secret, asset_id, asset_amount])
//
// where asset_id is BigInt(assetAddress). Computable from the stored note
// ALONE — no wallet / PRF ceremony — because the note already carries its
// own secret. Returns null when the note has no leaf position yet (it can't
// have been spent, so it can't have been nullified).
export function noteNullifier(note: {
  leafIndex?: number;
  owner: string;
  secret: string;
  asset: string;
  amount: string;
}): string | null {
  if (note.leafIndex === undefined) return null;
  const n = poseidon2Hash([
    BigInt(note.leafIndex),
    BigInt(note.owner),
    BigInt(note.secret),
    BigInt(note.asset),
    BigInt(note.amount),
  ]);
  return "0x" + n.toString(16).padStart(64, "0");
}

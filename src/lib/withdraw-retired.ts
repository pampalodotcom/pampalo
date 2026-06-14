// ADR 0022 — prepare a "Withdraw to wallet" transaction for a single RETIRED
// note: an `unshieldBundled` against the OLD contract that exits the note's
// FULL amount to the user's own EVM address. Thin wrapper over `prepareUnshield`
// — the only differences from a normal unshield are (1) the target is the old
// deployment + its rebuilt tree, and (2) `exitAmount === note.amount`, so no
// change output is produced (a change note would land in the dead tree).
//
// Kept separate from the sheet so the leafIndex-recovery + full-exit invariants
// are unit-testable (WS5) without React.

import {
  prepareUnshield,
  type PreparedUnshieldTx,
} from "./unshield-prep";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";

export type RetiredNote = {
  /** Lowercased asset address. */
  asset: string;
  /** Amount in base units, decimal string (StoredNote shape). */
  amount: string;
  /** Per-note secret, 0x + 64 hex. */
  secret: string;
  /** Owner Poseidon identifier, 0x + 64 hex. */
  owner: string;
  /** Leaf commitment, 0x + 64 hex — the key into the rebuilt old tree. */
  leafCommitment: string;
  /** Absolute leaf index, if the note still carries it (synced while the
   *  deployment was active). Absent on a fresh-device note rebuilt from the
   *  archived ciphertext — recovered from the tree's commitment map. */
  leafIndex?: number;
};

/** Recover a retired note's leaf index: prefer the stored one, else look the
 *  commitment up in the rebuilt old tree. Throws if neither yields it (a note
 *  whose leaf isn't in the archived snapshot can't be proven). */
export function resolveRetiredLeafIndex(
  note: Pick<RetiredNote, "leafCommitment" | "leafIndex">,
  commitmentToLeafIndex: Map<string, number>,
): number {
  if (note.leafIndex !== undefined) return note.leafIndex;
  const found = commitmentToLeafIndex.get(note.leafCommitment.toLowerCase());
  if (found === undefined) {
    throw new Error(
      `retired note ${note.leafCommitment} not found in the archived leaf set — cannot withdraw`,
    );
  }
  return found;
}

export type PrepareRetiredWithdrawalInput = {
  chainId: number;
  /** Lowercased OLD (retired) Pampalo address. */
  oldPampalo: string;
  note: RetiredNote;
  /** Rebuilt old tree (useRetiredTree). */
  tree: PoseidonMerkleTreeType;
  /** Commitment → leafIndex from the same rebuild, for index recovery. */
  commitmentToLeafIndex: Map<string, number>;
  /** Public payout target — the user's own EVM address (lowercased 0x…). */
  exitAddress: string;
  walletPrivateKey: string;
  selfPoseidon: string;
  selfEnvelopePubKey: string;
};

/** Build (without broadcasting) the full-amount withdrawal of one retired
 *  note. `exitAmount === note.amount` ⇒ `prepareUnshield` emits no change
 *  output. */
export async function prepareRetiredWithdrawal(
  input: PrepareRetiredWithdrawalInput,
): Promise<PreparedUnshieldTx> {
  const {
    chainId,
    oldPampalo,
    note,
    tree,
    commitmentToLeafIndex,
    exitAddress,
    walletPrivateKey,
    selfPoseidon,
    selfEnvelopePubKey,
  } = input;

  const leafIndex = resolveRetiredLeafIndex(note, commitmentToLeafIndex);
  const amount = BigInt(note.amount);

  return prepareUnshield({
    chainId,
    pampaloAddress: oldPampalo,
    inputNote: {
      asset: note.asset,
      amount,
      secret: note.secret,
      owner: note.owner,
      leafIndex,
    },
    exitAddress,
    exitAmount: amount, // full amount → no change output (dead-tree change)
    walletPrivateKey,
    selfPoseidon,
    selfEnvelopePubKey,
    tree,
  });
}

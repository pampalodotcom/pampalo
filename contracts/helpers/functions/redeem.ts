import { Redeem } from "@pampalo/shared/classes/Redeem";
import { getRedeemNullifier } from "@pampalo/shared/constants/zk";
import { type PoseidonMerkleTree } from "../../helpers/objects/poseidon-merkle-tree.js";

// Witness + proof generator for the `redeem` (proof-of-payment) circuit.
// The caller knows the merchant payment note they created (asset, amount,
// merchantId = note owner, secret) and its leaf_index once indexed; this
// resolves the merkle path from the mirror tree, computes the redeem
// nullifier, and produces a proof bound to (recipient, consumer,
// reference).

export interface RedeemNoteParams {
  assetId: bigint | string; // asset address as a field
  assetAmount: bigint | string; // base units
  merchantId: bigint | string; // note owner (Poseidon identifier)
  secret: bigint | string; // the note secret the buyer chose
  leafIndex: bigint; // position of the payment leaf in the tree
}

export const getRedeemDetails = async (
  tree: PoseidonMerkleTree,
  note: RedeemNoteParams,
  recipient: string, // EVM address the asset is delivered to
  consumer: string, // the consuming contract allowed to settle
  reference: bigint | string, // opaque consumer-defined binding
) => {
  const redeem = new Redeem();
  await redeem.init();

  const root = await tree.getRoot();
  const merkleProof = await tree.getProof(Number(note.leafIndex));

  const redeemNullifier = await getRedeemNullifier(
    note.leafIndex,
    note.merchantId,
    note.secret,
    note.assetId,
    note.assetAmount,
  );

  const toField = (v: bigint | string) =>
    "0x" + BigInt(v.toString()).toString(16);

  const { witness } = await redeem.redeemNoir.execute({
    root: toField(root.toString()),
    redeem_nullifier: toField(redeemNullifier),
    merchant_id: toField(note.merchantId),
    asset_id: toField(note.assetId),
    asset_amount: toField(note.assetAmount),
    recipient: toField(BigInt(recipient)),
    consumer: toField(BigInt(consumer)),
    reference: toField(reference),
    secret: toField(note.secret),
    leaf_index: toField(note.leafIndex),
    path: merkleProof.siblings.map((s: bigint | string) =>
      toField(BigInt(s.toString())),
    ),
    path_indices: merkleProof.indices.map((i: bigint | number) => i.toString()),
  });

  const proof = await redeem.redeemBackend.generateProof(witness, {
    keccakZK: true,
  });

  return { proof, redeemNullifier };
};

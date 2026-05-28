import type { ShieldNote } from "@pampalo/shared/types/notes";
import { Shield } from "@pampalo/shared/classes/Shield";
import { poseidon2Hash } from "@zkpassport/poseidon2";

// Witness + proof generator for the `shield` circuit. Given a
// ShieldNote (assetId / assetAmount / owner / secret), computes the
// poseidon leaf hash, runs the noir witness builder, and produces
// the bb.js proof. Returned `proof.publicInputs` is what the
// `Pampalo.shield` / `Pampalo.shieldNative` calldata expects in slot 0
// (hash), slot 1 (asset_id), slot 2 (asset_amount).

export const getShieldDetails = async (shieldNote: ShieldNote) => {
  const { assetId, assetAmount, secret, owner } = shieldNote;

  const shield = new Shield();
  await shield.init();

  const noteHash = poseidon2Hash([
    BigInt(assetId),
    BigInt(assetAmount),
    BigInt(owner),
    BigInt(secret),
  ]);

  const noteHashN = BigInt(noteHash.toString());

  const { witness } = await shield.shieldNoir.execute({
    hash: noteHashN.toString(),
    asset_id: BigInt(assetId).toString(),
    asset_amount: assetAmount.toString(),
    owner: owner.toString(),
    secret: secret.toString(),
  });

  const proof = await shield.shieldBackend.generateProof(witness, {
    keccakZK: true,
  });

  return { proof };
};

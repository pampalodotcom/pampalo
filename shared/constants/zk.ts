import { ethers } from "ethers";

// Random scalar in the BN254 scalar field (the field Noir/UltraHonk
// operates over). Used for note secrets, sibling padding, etc.

const BN254_PRIME = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

export const getRandomInPoseidonField = () => {
  return BigInt(ethers.hexlify(ethers.randomBytes(32))) % BN254_PRIME;
};

// Domain tag for the redeem (proof-of-payment) nullifier. MUST stay in
// lockstep with REDEEM_DOMAIN in circuits/pum_lib/src/lib.nr. Distinct
// from the spend nullifier so a redeem can't grief the merchant's later
// spend of the same note. Value = keccak256("PAMPALO_REDEEM_V1") mod p.
export const REDEEM_DOMAIN =
  BigInt(ethers.keccak256(ethers.toUtf8Bytes("PAMPALO_REDEEM_V1"))) %
  BN254_PRIME;

// Compute the redeem nullifier for a note paid to a merchant. Mirrors
// pum_lib::compute_redeem_nullifier -- poseidon2 over
// [REDEEM_DOMAIN, leaf_index, owner, secret, asset_id, asset_amount].
export const getRedeemNullifier = async (
  leafIndex: bigint | string,
  owner: bigint | string,
  secret: bigint | string,
  assetId: bigint | string,
  assetAmount: bigint | string,
): Promise<bigint> => {
  const { poseidon2Hash } = await import("@zkpassport/poseidon2");
  const nf = poseidon2Hash([
    REDEEM_DOMAIN,
    BigInt(leafIndex),
    BigInt(owner),
    BigInt(secret),
    BigInt(assetId),
    BigInt(assetAmount),
  ]);
  return BigInt(nf.toString());
};

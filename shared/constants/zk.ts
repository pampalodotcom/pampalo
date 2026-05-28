import { ethers } from "ethers";

// Random scalar in the BN254 scalar field (the field Noir/UltraHonk
// operates over). Used for note secrets, sibling padding, etc.

const BN254_PRIME = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

export const getRandomInPoseidonField = () => {
  return BigInt(ethers.hexlify(ethers.randomBytes(32))) % BN254_PRIME;
};

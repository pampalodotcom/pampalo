// Deterministic key derivation from a wallet mnemonic.
//
// Three flavours of "address" come out of the same HDNodeWallet:
//
//   evm       — checksummed Ethereum address (m/44'/60'/0'/0/0). Public.
//   envelope  — uncompressed secp256k1 public key (0x04 || X || Y, 65 bytes
//               of hex). Used as the ECIES encryption target for note
//               passing. Public.
//   poseidon  — poseidon2([BigInt(privateKey)]) over BN254, left-padded to
//               64 hex chars. Used as the unlinkable on-chain identifier
//               inside ZK notes. Public, but unlinkable to the EVM address.
//
// Lives in keystore.ts → localStorage once derived; the mnemonic itself is
// never persisted (per AUTH.md §8.3).
//
// BN254 scalar field prime; everything Poseidon2-hashed lives mod r.
// Kept here for callers who need to reduce a witness explicitly (e.g.
// `ownerSecret = privateKey % POSEIDON_MAX` inside ZK circuits).

import type { HDNodeWallet } from "ethers";
import { SigningKey } from "ethers";
import { poseidon2Hash } from "@zkpassport/poseidon2";

export const POSEIDON_MAX = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

export type DerivedAddresses = {
  evm: string; // checksummed Ethereum address
  envelope: string; // uncompressed secp256k1 public key (0x04…)
  poseidon: string; // 0x + 64 hex chars
};

export function deriveAddresses(wallet: HDNodeWallet): DerivedAddresses {
  const evm = wallet.address;

  // Public key directly from the private key — no need to round-trip
  // through `signMessage` since we always have the Wallet here.
  const envelope = new SigningKey(wallet.privateKey).publicKey;

  // poseidon2Hash returns a bigint in the BN254 field. Pad to 64 hex chars
  // so it round-trips with on-chain fixed-width representations.
  const poseidonHash = poseidon2Hash([BigInt(wallet.privateKey)]);
  const poseidon = "0x" + poseidonHash.toString(16).padStart(64, "0");

  return { evm, envelope, poseidon };
}

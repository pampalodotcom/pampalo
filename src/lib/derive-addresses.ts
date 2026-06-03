// Deterministic key derivation from a wallet mnemonic.
//
// Four flavours of "address" come out of the same mnemonic:
//
//   evm              — checksummed Ethereum address (m/44'/60'/0'/0/0). Public.
//   envelope         — uncompressed secp256k1 public key (0x04 || X || Y, 65
//                      bytes of hex) at BIP44 path 0 (= same key as EVM).
//                      ECIES encryption target on chains that share the
//                      "hot" demo key (`separateDerivationKey: false`).
//                      Today: Base Sepolia. Public.
//   envelopeIsolated — uncompressed secp256k1 public key at the Pampalo
//                      isolated envelope path (m/44'/60'/0'/0/420). Used
//                      as the ECIES target on chains with
//                      `separateDerivationKey: true` (mainnets) so a
//                      future "hot Sync" compromise of the demo path
//                      doesn't leak the ability to decrypt mainnet notes.
//                      Public.
//   poseidon         — poseidon2([BigInt(BIP44_path0_privateKey)]) over
//                      BN254, left-padded to 64 hex chars. Used as the
//                      unlinkable on-chain identifier inside ZK notes.
//                      Public, but unlinkable to the EVM address.
//                      Shared across chains (the spend authority).
//
// Lives in keystore.ts → localStorage once derived; the mnemonic itself is
// never persisted (per AUTH.md §8.3).
//
// BN254 scalar field prime; everything Poseidon2-hashed lives mod r.
// Kept here for callers who need to reduce a witness explicitly (e.g.
// `ownerSecret = privateKey % POSEIDON_MAX` inside ZK circuits).

import {
  HDNodeWallet,
  SigningKey,
  Wallet,
  type HDNodeWallet as HDNodeWalletT,
} from "ethers";
import { poseidon2Hash } from "@zkpassport/poseidon2";

export const POSEIDON_MAX = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

// Pampalo's "isolated envelope" leaf index. Lives at BIP44 path
//   m/44'/60'/0'/0/420
// Independent of the path-0 EVM key (hardened HD tree → leaves can't
// be derived from each other), so a hot Sync compromise on a chain
// that uses the path-0 envelope (Base Sepolia) cannot derive this key.
export const ENVELOPE_ISOLATED_SLOT = 420;
const ENVELOPE_ISOLATED_PATH = `m/44'/60'/0'/0/${ENVELOPE_ISOLATED_SLOT}`;

export type DerivedAddresses = {
  evm: string; // checksummed Ethereum address
  envelope: string; // uncompressed secp256k1 public key at path 0
  /** Uncompressed secp256k1 public key at the Pampalo isolated envelope
   *  path (slot 420). Optional for backward compat with users who signed
   *  in before this field was added — the next PRF unlock populates it. */
  envelopeIsolated?: string;
  poseidon: string; // 0x + 64 hex chars
};

export function deriveAddresses(wallet: HDNodeWalletT): DerivedAddresses {
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

/** Full derivation in one pass. Takes the raw mnemonic and returns all
 *  four identifiers — path-0 triple + the isolated envelope at slot 420.
 *  Call this on every PRF unlock so the cached addresses cover both the
 *  shared and the isolated envelope without needing a follow-up prompt. */
export function deriveAllAddresses(mnemonic: string): DerivedAddresses {
  const sharedWallet = Wallet.fromPhrase(mnemonic);
  const triple = deriveAddresses(sharedWallet);
  const envelopeIsolated = deriveEnvelopeIsolatedPubKey(mnemonic);
  return { ...triple, envelopeIsolated };
}

/** Just the slot-420 envelope public key. Useful for the lazy-fill path
 *  (existing users whose persisted addresses predate this change). */
export function deriveEnvelopeIsolatedPubKey(mnemonic: string): string {
  const wallet = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    ENVELOPE_ISOLATED_PATH,
  );
  return new SigningKey(wallet.privateKey).publicKey;
}

/** Private key for the isolated envelope path. Used by future hot-Sync
 *  decryption when scanning notes on chains with separateDerivationKey:
 *  true. The shared envelope private key is just BIP44 path 0 (= the
 *  EVM wallet's privateKey) — no helper needed for that. */
export function deriveEnvelopeIsolatedPrivateKey(mnemonic: string): string {
  const wallet = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    ENVELOPE_ISOLATED_PATH,
  );
  return wallet.privateKey;
}

/** Pick the right envelope public key for a deployment. Receive UI calls
 *  this with the deployment's `separateDerivationKey` flag. Returns null
 *  when the isolated envelope is needed but hasn't been derived yet —
 *  the caller should trigger a PRF unlock to populate the cache. */
export function envelopeForDeployment(
  addrs: DerivedAddresses,
  separateDerivationKey: boolean,
): string | null {
  if (!separateDerivationKey) return addrs.envelope;
  return addrs.envelopeIsolated ?? null;
}

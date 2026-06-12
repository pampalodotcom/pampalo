// Deterministic key derivation from an agent account's mnemonic.
//
// Ported from the web app's `src/lib/derive-addresses.ts` — same four
// identifiers come out of the same mnemonic, so a CLI-custodied account and
// a browser wallet built from the same recovery phrase are on-chain
// identical. The only difference here is environment: pure Node, no
// browser crypto.
//
//   evm              — checksummed Ethereum address (m/44'/60'/0'/0/0). Public.
//   envelope         — uncompressed secp256k1 public key at path 0. The
//                      ECIES target on chains sharing the path-0 key.
//   envelopeIsolated — uncompressed secp256k1 public key at the isolated
//                      envelope path (m/44'/60'/0'/0/420). ECIES target on
//                      chains with `separateDerivationKey: true`.
//   poseidon         — poseidon2([privateKey]) over BN254, left-padded to
//                      64 hex. The unlinkable on-chain note identifier.

import { HDNodeWallet, SigningKey, Wallet } from "ethers";
import { poseidon2Hash } from "@zkpassport/poseidon2";

// BN254 scalar field prime. Poseidon witnesses live mod r.
export const POSEIDON_MAX = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

export const ENVELOPE_ISOLATED_SLOT = 420;
const ENVELOPE_ISOLATED_PATH = `m/44'/60'/0'/0/${ENVELOPE_ISOLATED_SLOT}`;

export type DerivedAddresses = {
  /** Checksummed Ethereum address. */
  evm: string;
  /** Uncompressed secp256k1 public key (0x04 || X || Y) at path 0. */
  envelope: string;
  /** Uncompressed secp256k1 public key at the isolated envelope slot (420). */
  envelopeIsolated: string;
  /** Poseidon identifier: 0x + 64 hex. */
  poseidon: string;
};

/** All four identifiers from a mnemonic, in one pass. */
export function deriveAllAddresses(mnemonic: string): DerivedAddresses {
  const wallet = Wallet.fromPhrase(mnemonic);

  const evm = wallet.address;
  const envelope = new SigningKey(wallet.privateKey).publicKey;

  // poseidon2Hash reduces its inputs mod the field, so hashing the full
  // 256-bit private key matches the circuit's poseidon2([privateKey % r]).
  const poseidonHash = poseidon2Hash([BigInt(wallet.privateKey)]);
  const poseidon = "0x" + poseidonHash.toString(16).padStart(64, "0");

  const envelopeIsolated = new SigningKey(
    isolatedWallet(mnemonic).privateKey,
  ).publicKey;

  return { evm, envelope, envelopeIsolated, poseidon };
}

/** Private key for the path-0 (EVM) key — the shared-envelope decrypt key
 *  and the transfer circuit's `owner_secret` source. */
export function deriveSpendPrivateKey(mnemonic: string): string {
  return Wallet.fromPhrase(mnemonic).privateKey;
}

/** Private key for the isolated envelope path (slot 420). Used to
 *  trial-decrypt inbound notes on chains with separateDerivationKey: true. */
export function deriveEnvelopeIsolatedPrivateKey(mnemonic: string): string {
  return isolatedWallet(mnemonic).privateKey;
}

function isolatedWallet(mnemonic: string): HDNodeWallet {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, ENVELOPE_ISOLATED_PATH);
}

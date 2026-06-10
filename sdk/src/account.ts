// Account — the in-memory handle for a Pampalo agent account.
//
// Unlocked once per process (Account.create / import / load decrypt the
// keystore), the mnemonic and signing key are held in memory for the run
// and reused across operations — no per-call passphrase prompt. See ADR
// 0014 + CONTEXT.md "Agent account" / "Account keystore".
//
// This first slice covers identity + custody only. Transport, sync, the
// SQLite note store, and the intent builders (transfer/shield/unshield/send)
// land on top of this class in later modules.

import { HDNodeWallet, Mnemonic, Wallet } from "ethers";
import {
  type DerivedAddresses,
  deriveAllAddresses,
  deriveEnvelopeIsolatedPrivateKey,
  deriveSpendPrivateKey,
} from "./addresses.js";
import {
  keystoreExists,
  readKeystore,
  writeKeystore,
} from "./keystore.js";

export class Account {
  /** Account name (the keystore filename), or null for an ephemeral
   *  (env / fromMnemonic) account with no file backing. */
  readonly name: string | null;
  readonly addresses: DerivedAddresses;

  // Held in memory for the process lifetime; never persisted in plaintext,
  // never logged.
  #mnemonic: string;

  private constructor(mnemonic: string, name: string | null) {
    this.#mnemonic = mnemonic;
    this.name = name;
    this.addresses = deriveAllAddresses(mnemonic);
  }

  /** Create a brand-new agent account: a fresh mnemonic — a distinct
   *  identity, NOT the user's web wallet — written to an encrypted keystore. */
  static async create(opts: {
    name: string;
    passphrase: string;
    dir?: string;
  }): Promise<Account> {
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    return Account.#persist(mnemonic, opts);
  }

  /** Import an existing recovery phrase into a new keystore (explicit
   *  opt-in — by default agents get a fresh identity via create()). */
  static async import(opts: {
    name: string;
    passphrase: string;
    mnemonic: string;
    dir?: string;
  }): Promise<Account> {
    const mnemonic = normalizeMnemonic(opts.mnemonic);
    return Account.#persist(mnemonic, opts);
  }

  /** Unlock an existing keystore. Throws "wrong passphrase" on a bad key. */
  static async load(opts: {
    name: string;
    passphrase: string;
    dir?: string;
  }): Promise<Account> {
    const { mnemonic } = await readKeystore(opts);
    return new Account(mnemonic, opts.name);
  }

  /** Ephemeral account from a raw mnemonic (e.g. PAMPALO_MNEMONIC) — never
   *  touches disk. For CI / one-shot runs. */
  static fromMnemonic(mnemonic: string, name: string | null = null): Account {
    return new Account(normalizeMnemonic(mnemonic), name);
  }

  static async #persist(
    mnemonic: string,
    opts: { name: string; passphrase: string; dir?: string },
  ): Promise<Account> {
    if (await keystoreExists(opts.name, opts.dir)) {
      throw new Error(`account "${opts.name}" already exists`);
    }
    const account = new Account(mnemonic, opts.name);
    await writeKeystore({
      name: opts.name,
      mnemonic,
      passphrase: opts.passphrase,
      address: account.addresses.evm,
      dir: opts.dir,
    });
    return account;
  }

  /** ethers signing wallet (path 0). Consumed by the broadcast / intent
   *  layer; kept off the public surface so callers reach for `addresses`
   *  for read-only needs. */
  signer(): HDNodeWallet {
    return Wallet.fromPhrase(this.#mnemonic);
  }

  /** Spend / shared-envelope private key (path 0). */
  spendPrivateKey(): string {
    return deriveSpendPrivateKey(this.#mnemonic);
  }

  /** Isolated-envelope private key (slot 420) for note trial-decrypt on
   *  separate-derivation chains. */
  envelopeIsolatedPrivateKey(): string {
    return deriveEnvelopeIsolatedPrivateKey(this.#mnemonic);
  }
}

function normalizeMnemonic(input: string): string {
  const phrase = input.trim().replace(/\s+/g, " ").toLowerCase();
  // Validate against BIP39 wordlist + checksum; throws on a bad phrase.
  Mnemonic.fromPhrase(phrase);
  return phrase;
}

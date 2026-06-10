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

import { Contract, HDNodeWallet, Interface, Mnemonic, Wallet } from "ethers";
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
import { type RpcConfig, RpcTransport, type Transport } from "./transport.js";
import { isNativeAsset } from "./constants.js";
import { Store, defaultDbPath } from "./store.js";
import type { StoredNote } from "./store.js";
import { syncDeployment } from "./sync.js";
import type { SyncResult } from "./sync.js";
import { DEPLOYMENTS } from "./deployments.js";

/** A token to look up when reading a public balance. */
export type TokenRef = { address: string; decimals: number; symbol: string };

/** Public (on-chain, cleartext) balance on one chain. Private note
 *  holdings and shield statuses are added by a later slice. */
export type PublicBalance = {
  chainId: number;
  native: { wei: string };
  tokens: Array<{
    address: string;
    wei: string;
    decimals: number;
    symbol: string;
  }>;
};

/** An unsigned public-transfer intent (to, value, data) — the network-free
 *  half of `send`, kept separate so it mirrors the intent/sign split the
 *  private path uses and is testable without a provider. */
export type SendIntent = { to: string; value: bigint; data: string };

/** Private (note) balance on one chain, summed per asset from spendable notes. */
export type PrivateBalance = {
  chainId: number;
  byAsset: Array<{
    asset: string;
    spendable: string;
    decimals: number;
    symbol?: string;
  }>;
};

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export class Account {
  /** Account name (the keystore filename), or null for an ephemeral
   *  (env / fromMnemonic) account with no file backing. */
  readonly name: string | null;
  readonly addresses: DerivedAddresses;

  // Held in memory for the process lifetime; never persisted in plaintext,
  // never logged.
  #mnemonic: string;
  #transport: Transport | null = null;
  #store: Store | null = null;

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

  // ── Transport ───────────────────────────────────────────────────────

  /** Configure direct-RPC access: `{ [chainId]: url }`. Returns `this` for
   *  chaining. A custom `Transport` (e.g. a future Convex transport) can be
   *  supplied instead via `connect()`. */
  useRpc(urls: RpcConfig): this {
    this.#transport = new RpcTransport(urls);
    return this;
  }

  /** Attach an arbitrary transport implementation. */
  connect(transport: Transport): this {
    this.#transport = transport;
    return this;
  }

  #requireTransport(): Transport {
    if (!this.#transport) {
      throw new Error(
        "no transport configured — call account.useRpc({ [chainId]: url })",
      );
    }
    return this.#transport;
  }

  // ── Public path (no proofs, no notes) ───────────────────────────────

  /** Public on-chain balance: native + any requested ERC-20s. */
  async balance(opts: {
    chainId: number;
    tokens?: TokenRef[];
  }): Promise<PublicBalance> {
    const provider = this.#requireTransport().provider(opts.chainId);
    const me = this.addresses.evm;
    const tokenList = opts.tokens ?? DEPLOYMENTS[opts.chainId]?.tokens ?? [];

    const [nativeWei, tokens] = await Promise.all([
      provider.getBalance(me),
      Promise.all(
        tokenList.map(async (t) => {
          const erc20 = new Contract(t.address, ERC20, provider);
          const wei = (await erc20.getFunction("balanceOf")(me)) as bigint;
          return {
            address: t.address.toLowerCase(),
            wei: wei.toString(),
            decimals: t.decimals,
            symbol: t.symbol,
          };
        }),
      ),
    ]);

    return {
      chainId: opts.chainId,
      native: { wei: nativeWei.toString() },
      tokens,
    };
  }

  /** Build the unsigned (to, value, data) for a public transfer — native
   *  ETH or an ERC-20 `transfer`. Network-free; `send` wraps this with
   *  nonce/fee population, signing, and broadcast. */
  buildSend(opts: { to: string; asset?: string; amount: bigint }): SendIntent {
    if (isNativeAsset(opts.asset)) {
      return { to: opts.to, value: opts.amount, data: "0x" };
    }
    return {
      to: opts.asset!,
      value: 0n,
      data: ERC20.encodeFunctionData("transfer", [opts.to, opts.amount]),
    };
  }

  /** Public EVM transfer (native or ERC-20). Self-broadcast: the agent's
   *  EVM address is the visible `msg.sender`. */
  async send(opts: {
    chainId: number;
    to: string;
    asset?: string;
    amount: bigint;
  }): Promise<{ txHash: string }> {
    const provider = this.#requireTransport().provider(opts.chainId);
    const wallet = this.signer().connect(provider);
    const intent = this.buildSend(opts);
    const tx = await wallet.sendTransaction(intent);
    return { txHash: tx.hash };
  }

  // ── Store + private path ────────────────────────────────────────────

  /** Attach the SQLite note store (defaults to ~/.pampalo/pampalo.db). */
  useStore(store: Store | string = defaultDbPath()): this {
    this.#store = typeof store === "string" ? new Store(store) : store;
    return this;
  }

  #requireStore(): Store {
    if (!this.#store) {
      throw new Error("no store configured — call account.useStore()");
    }
    return this.#store;
  }

  #key(): string {
    return this.addresses.evm.toLowerCase();
  }

  /** Scan the chain and update the local note store + leaf set. Resolves
   *  the deployment + start block from the registry unless overridden. */
  async sync(opts: {
    chainId: number;
    deployment?: string;
    fromBlock?: number;
    toBlock?: number;
    chunk?: number;
  }): Promise<SyncResult> {
    const store = this.#requireStore();
    const provider = this.#requireTransport().provider(opts.chainId);
    const reg = DEPLOYMENTS[opts.chainId];
    const deployment = opts.deployment ?? reg?.pampalo;
    if (!deployment) {
      throw new Error(
        `no deployment for chainId ${opts.chainId} — pass { deployment, fromBlock }`,
      );
    }
    const decimalsByAsset = new Map<string, number>();
    for (const t of reg?.tokens ?? []) {
      decimalsByAsset.set(t.address.toLowerCase(), t.decimals);
    }
    return syncDeployment({
      store,
      provider,
      keys: {
        evm: this.#key(),
        poseidon: this.addresses.poseidon,
        spendPrivKey: this.spendPrivateKey(),
        isoPrivKey: this.envelopeIsolatedPrivateKey(),
      },
      chainId: opts.chainId,
      deployment,
      fromBlock: opts.fromBlock ?? reg?.fromBlock ?? 0,
      toBlock: opts.toBlock,
      decimalsByAsset,
      chunk: opts.chunk,
    });
  }

  /** Private balance — spendable note amounts summed per asset. */
  privateBalance(opts: { chainId: number }): PrivateBalance {
    const notes = this.#requireStore().listNotes({
      account: this.#key(),
      chainId: opts.chainId,
      state: "spendable",
    });
    const symbols = new Map<string, string>();
    for (const t of DEPLOYMENTS[opts.chainId]?.tokens ?? []) {
      symbols.set(t.address.toLowerCase(), t.symbol);
    }
    const byAsset = new Map<string, { spendable: bigint; decimals: number }>();
    for (const n of notes) {
      const cur = byAsset.get(n.asset) ?? {
        spendable: 0n,
        decimals: n.assetDecimals,
      };
      cur.spendable += BigInt(n.amount);
      byAsset.set(n.asset, cur);
    }
    return {
      chainId: opts.chainId,
      byAsset: [...byAsset].map(([asset, v]) => ({
        asset,
        spendable: v.spendable.toString(),
        decimals: v.decimals,
        symbol: symbols.get(asset),
      })),
    };
  }

  /** Shield notes + their lifecycle state (queued / spendable / cancelled
   *  / contested) for the shield-status view. */
  shields(opts: { chainId: number }): StoredNote[] {
    return this.#requireStore()
      .listNotes({ account: this.#key(), chainId: opts.chainId })
      .filter((n) => n.origin === "shield");
  }
}

function normalizeMnemonic(input: string): string {
  const phrase = input.trim().replace(/\s+/g, " ").toLowerCase();
  // Validate against BIP39 wordlist + checksum; throws on a bad phrase.
  Mnemonic.fromPhrase(phrase);
  return phrase;
}

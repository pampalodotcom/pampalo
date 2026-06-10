# @pampalo/sdk

> The programmatic core for **agent accounts** — Pampalo identities
> custodied and operated outside the browser, by Node/TS code. This is
> what an agent imports. `@pampalo/cli` is a thin wrapper over it.

A new workspace package in the monorepo (`sdk/`). Depends on
`@pampalo/shared` via `workspace:*` for all protocol crypto — do not
reimplement notes, proofs, ECIES, or the merkle tree here; orchestrate them.

---

## Where it sits

```
@pampalo/shared   protocol crypto (notes, proofs, ECIES, tree)   ← dependency (workspace:*)
@pampalo/sdk      ← you are here. Account, keystore, store, sync, broadcast.
@pampalo/cli      depends on @pampalo/sdk (workspace:*). The `pampalo` binary.
```

**Dev loop:** all three are workspace packages in one monorepo, so a change
in `shared` is visible immediately — no linking. Changesets rewrites
`workspace:*` to the real version at publish time and releases `shared`
before `sdk`/`cli` in dependency order.

## Core concepts (canonical glossary — match the main repo exactly)

- **Agent account** — a Pampalo identity created/custodied outside the
  browser. Same on-chain shape as a web wallet (one **mnemonic** →
  one EVM address, one **envelope key**, one **Poseidon identifier**), but
  created fresh by `Account.create()` as a *distinct* identity — not the
  user's human web wallet. `Account.import()` brings in an existing
  **recovery phrase** as an explicit opt-in. An agent account has **no
  Convex wallet row and no passkey** — it is unknown to the web auth model.
- **Account keystore** — the encrypted-at-rest home for the mnemonic,
  modelled on `~/.ssh/`: a scrypt + AES-GCM file under
  `~/.pampalo/accounts/<name>.json`. Passphrase-protected; unlocked once
  per process and held in memory for the run. This **deliberately
  reintroduces the scrypt-passphrase scheme the web wallet forbids**
  (ADR 0002) — but only here, because Node has no WebAuthn/PRF authenticator
  to derive a key from. See SECURITY below.
- **Account transport** — the pluggable channel for chain reads +
  broadcast. Day-1 is a direct RPC client (user-supplied URL); a
  Convex-backed transport (relayer privacy + note hydrate) comes later
  behind the same interface.
- **Proposal** (deferred) — a future keyless mode where an agent
  ECIES-encrypts a transaction *intent* to a human's envelope key and a
  human approves with their passkey. The SDK is built so the **intent
  builders are separate from sign+broadcast**, so the same builder later
  feeds either local signing (day-1) or remote proposal.

## Public API (target surface)

```ts
import { Account } from "@pampalo/sdk";

// ── lifecycle ───────────────────────────────────────────────
await Account.create({ name, passphrase });                 // fresh mnemonic + keystore
await Account.import({ name, passphrase, mnemonic });        // existing recovery phrase
await Account.load({ name, passphrase });                    // unlock existing keystore
Account.fromMnemonic(process.env.PAMPALO_MNEMONIC!);         // ephemeral / CI, no disk

acct.addresses;   // { evm, envelope, envelopeIsolated, poseidon }

// ── transport ───────────────────────────────────────────────
acct.useRpc({ 84532: { url: "https://…", nativeSymbol: "ETH", nativeDecimals: 18 } });

// ── read ────────────────────────────────────────────────────
await acct.sync({ chainId });          // scan logs → trial-decrypt → rebuild tree → mark spends
await acct.balance({ chainId });       // { publicWei, privateBaseUnits, shields: ShieldStatus[] }

// ── intents (pure) → sign+broadcast (day-1) ────────────────
await acct.transfer({ chainId, to: { poseidon, envelope }, asset, amount });  // private note→note
await acct.send({ chainId, to: evmAddress, asset, amount });                  // public EVM
await acct.shield({ chainId, asset, amount });                                // public→private (to self, v1)
await acct.unshield({ chainId, asset, amount, recipient });                   // private→public

// ── intent/sign separation (enables future Proposal) ───────
const intent = await acct.buildTransfer({ … });   // → unsigned tx envelope, no broadcast
const txHash = await acct.signAndBroadcast(intent);
```

`balance().shields` reports each shield's lifecycle: `queued → executable →
executed` (approved) vs `cancelled` / `contested` (disallowed) — derived
from scanned `ShieldQueued`/`ShieldExecuted`/`ShieldCancelled`/
`ShieldContested` events.

## Module layout

```
src/
  account.ts        Account class — orchestrates the below
  keystore.ts       scrypt + AES-GCM read/write of ~/.pampalo/accounts/<name>.json
  addresses.ts      mnemonic → { evm, envelope, envelopeIsolated, poseidon }
                    (port from the web app's derive-addresses.ts)
  transport/
    rpc.ts          RpcClient interface + DirectRpcClient (port from web app src/lib/rpc.ts),
                    extended with getLogs + eth_call for sync
  store/
    db.ts           SQLite (better-sqlite3 or node:sqlite): accounts, notes, leaves, sync_cursors
    notes.ts        note CRUD (mirror the web app's StoredNote shape)
  sync.ts           eth_getLogs scan → trial-decrypt (envelope key) → ordered tree replay
  intents/          buildTransfer / buildShield / buildUnshield / buildSend
                    (port the PURE parts of the web app's *-prep.ts)
  broadcast.ts      sign (ethers) + sendRawTransaction  ← self-broadcast (day-1)
  index.ts
```

## SQLite schema (sketch)

```sql
accounts(name PK, evm, envelope, envelope_isolated, poseidon, created_at);
notes(leaf_commitment PK, account, chain_id, deployment, asset, amount,
      owner, secret, state, tree_index, leaf_index, unlock_time,
      queued_tx, spent_tx, nullifier);          -- mirrors StoredNote
leaves(chain_id, deployment, leaf_index, commitment, PRIMARY KEY(chain_id,deployment,leaf_index));
sync_cursors(chain_id, deployment, last_block, PRIMARY KEY(chain_id,deployment));
```

`leaves` holds **every** protocol leaf (public data) so the merkle tree
can be rebuilt incrementally for proofs without re-scanning history each op.

## Sync (the engine)

Incremental `eth_getLogs` from the stored cursor (assume an Alchemy-class
RPC with generous log ranges; chunked windows are a fast-follow). For each
window: trial-decrypt `NotePayload` / `ShieldQueued.encryptedPayload` with
the account's envelope private key (yours = the ones that decrypt); replay
every leaf insertion (`ShieldExecuted` joined to its `ShieldQueued`, plus
transfer output commitments) in chain order to assign leaf indices; mark
inputs spent from `NullifierUsed`.

## Day-1 scope

- **In:** `create`/`import`/`load`, direct-RPC transport, `sync`,
  `balance`, `shield`, `unshield`, `transfer` (self-broadcast), `send`.
- **Deferred:** Convex transport + relayer privacy, `.pampalo.eth`
  recipient resolution (raw `--poseidon/--envelope` only for now), the
  keyless Proposal flow, ssh-agent-style daemon, chunked log scans.

## Dependencies

`@pampalo/shared` (`workspace:*`), `ethers`, a SQLite driver
(`better-sqlite3` or Node's built-in `node:sqlite`), and a scrypt impl
(`@noble/hashes` or node:crypto). No browser APIs.

## SECURITY — read before touching keystore.ts

- The keystore reintroduces a scrypt-passphrase scheme the **web wallet
  refuses** (ADR 0002). That reversal is justified *only* because Node has
  no authenticator. **Never** add this code path to the web bundle.
- `Account.create()` makes a **fresh** identity. Do not silently reuse or
  derive from a human web wallet's mnemonic.
- Day-1 `transfer`/`unshield` **self-broadcast**, linking the agent's EVM
  address on-chain — a weaker privacy floor than the web wallet. Surface
  this to callers; do not hide it.
- Decrypted mnemonic / note secrets / proof witnesses: transient only,
  never persisted, never logged.

## Build & publish

`tsup` → ESM `dist` + `.d.ts`. `package.json`: `"type":"module"`,
`"license":"MIT"`, `repository` → `pampalodotcom/pampalo` with
`"directory":"sdk"`, `@pampalo/shared` as a `workspace:*` dependency,
`exports`/`types`/`files:["dist"]`, `engines.node ">=20"`,
`publishConfig:{ access:"public", provenance:true }`. Root MIT `LICENSE`.
Published by the monorepo's Changesets + OIDC workflow.

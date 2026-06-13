# Pampalo

Pampalo is a ZK private-money protocol: an EVM-anchored wallet whose deposits
become unlinkable on-chain notes, encrypted to recipients via ECIES and
identified on-chain by a SNARK-friendly hash of the owner's secret. Users
encrypt their own keys client-side using the WebAuthn PRF extension; the
Convex backend stores only ciphertext and public material.

## Privacy invariant

The privacy guarantee Pampalo makes publicly is **not** "the server can't
see your mnemonic." That's too narrow. It is:

> The Convex database stores the encrypted **mnemonic** and the public
> material needed to verify a WebAuthn ceremony. **Nothing else.** The
> server cannot link a user's on-chain notes to their EVM address; the
> recipient identity for any note is unlinkable on-chain.

Concretely:

- The plaintext mnemonic **never** leaves the client.
- Any new column on a user-scoped table must be (a) the encrypted
  mnemonic itself, (b) public WebAuthn material (`credentialId`,
  `publicKey`, `counter`, `transports`), or (c) opaque server primitives
  required for the protocol to function (session token, expiry, random
  user id). No user-supplied strings, no behavior timestamps, no labels.
- Treat this as a hard constraint when reviewing schema changes — if a
  field doesn't fit one of (a)/(b)/(c), it must move client-side
  (encrypted under the DEK) or be deleted.

## Client-side first

Pampalo is a **client-side-first** application. The Convex backend is
intentionally minimalist: it holds public catalog data (supported networks
+ tokens, Chainlink price/gas snapshots, Uniswap pool addresses),
short-lived auth state, and the ciphertext blobs governed by the privacy
invariant above. Anything that can run in the user's browser does.

The principle generalises the privacy invariant: the privacy invariant
constrains what the server **persists**; "client-side first" constrains
what the server **does** in transit. Specifically:

- **Stateless RPC proxies are permitted** for atomic, single-purpose
  calls that leak no more than `(chainId, address)` — the same tuple
  the existing balance proxy already sees in transit. The Alchemy API
  key lives server-side; once BYO RPC ships, these proxies become
  opt-in via the `RpcClient` indirection in `src/lib/rpc.ts`.
- **Bundled server-side builders are not permitted** when they would
  see a pre-broadcast unsigned transaction (`(from, to, value, data)`).
  Such a builder creates a censorship surface that doesn't exist for
  the atomic proxies. Decompose into atomic calls + client-side
  assembly instead. See ADR 0004.
- **User data that doesn't fit the privacy invariant moves to
  IndexedDB**, optionally synced via the encrypted-blob channel
  documented in `CLIENT_SIDE_FIRST.md` (preferences) — never as
  plaintext server columns.

The cost of this stance is some duplication (e.g. the Uniswap address
book in `src/lib/uniswap-swap.ts` mirrors the one in `convex/uniswap.ts`)
and occasional reach-back to the user (preferences sync needs a passkey
ceremony to push). We pay it deliberately: the smaller the server's role,
the smaller the surface where the privacy invariant can be quietly
violated by a well-meaning future engineer.

## Language

### Identity (derived from a single BIP39 mnemonic)

**EVM address**:
The public ethereum address (`m/44'/60'/0'/0/0`). Used as the gas/contract
identity — the on-chain handle for deposits, withdrawals, and any cleartext
transaction.

**Envelope key**:
The uncompressed secp256k1 public key (`0x04 || X || Y`) used as the ECIES
encryption target when another user sends this user a note. Specifically,
the **note secret** of every note addressed to a Poseidon identifier is
ECIES-encrypted to the recipient's envelope key so the recipient — and
only the recipient — can later read the secret out of public emit data,
store it locally, and use it to spend the note. A mnemonic has **two**
envelope keys — the **shared envelope** and the **isolated envelope** —
and which one a chain uses is fixed per deployment by
**`separateDerivationKey`** (see below). _Avoid_: "envelope address" (it
is a public key, not an address).

**Shared envelope**:
The envelope key at BIP44 path 0 (`m/44'/60'/0'/0/0`) — the *same* key as
the **EVM address**. Used on deployments where `separateDerivationKey` is
false (today: Base Sepolia, the testnet demo). "Shared" because the ECIES
target and the EVM signing identity are one key.

**Isolated envelope**:
The envelope key at the Pampalo isolated path (`m/44'/60'/0'/0/420`,
"slot 420") — a dedicated leaf independent of the EVM key. Used on
deployments where `separateDerivationKey` is true (mainnets). Isolating it
means a future "hot Sync" compromise of the testnet shared key cannot
decrypt mainnet notes. Because it post-dates earlier wallets, a sign-in
predating it derives it lazily on the next PRF unlock (`deriveAllAddresses`).

**`separateDerivationKey`**:
The per-deployment boolean that selects which envelope a chain uses:
false → **shared envelope**, true → **isolated envelope**. Canonical
default for an unset value: **isolated** (`!== false`). Every note-scanning
**Sync** trial-decrypts against *both* envelope private keys regardless of
this flag, so a wallet recovers notes no matter which envelope a sender
used — the flag only decides which key a *recipient publishes* and a
*sender encrypts to*.

**Poseidon identifier**:
`poseidon2([BigInt(privateKey)])` over BN254, zero-padded to 64 hex chars.
The unlinkable on-chain identifier used inside ZK notes; chosen so it
proves ownership inside a SNARK without revealing the EVM address.
_Avoid_: "ZK address", "shielded address"

### Encryption (client-side only)

**Mnemonic**:
The 12-word BIP39 phrase from which the EVM address, envelope key, and
Poseidon identifier are derived. Never persisted; lives in memory only
for the duration of a sign/unlock operation.

**Recovery phrase**:
The user-facing name for the **mnemonic** — the term used in all UI copy
("Back up your recovery phrase", "Export recovery phrase") and in the
**Recover account** flow. Same 12 words; "mnemonic" stays the
internal / encryption-layer term.
_Avoid_: "account phrase", "account secret", "seed phrase", and
especially "private key" (it is not one — keys are derived from it).

**Backed up**:
A wallet is backed up once the user has completed an export of the
**recovery phrase** — a passkey ceremony followed by an explicit Copy or
Download. Signup does not display the phrase or gate on backup: the
synced passkey is the primary recovery mechanism and the recovery phrase
is the escape hatch. Until backed up, the wallet home shows a nudge
banner (session-dismissable, CTA opens the export flow). Recorded as
`mnemonicBackedUpAt` inside the encrypted preferences blob — never as a
plaintext server column (a behaviour timestamp; the privacy invariant
forbids it). Monotonic: preference-sync merges take
`max(upstream, local)`, so a stale device can never un-back-up a wallet.

**DEK** (Data Encryption Key):
A 32-byte random AES-GCM-256 key generated at wallet creation. Encrypts
the mnemonic once. Re-wrapped under each registered passkey's KEK.

**KEK** (Key Encryption Key):
An AES-GCM-256 key derived from a passkey's PRF output via HKDF-SHA256
with the info string `wallet-v1-kek`. Wraps the DEK. Non-extractable.
One KEK per registered passkey; same DEK underneath.

**PRF output**:
The 32 bytes returned by the WebAuthn `prf` extension during a
`navigator.credentials.get()`. Stable per (credential, salt). Never
leaves the authenticator → browser boundary.

**Protection scheme**:
Passkey PRF is the only supported encryption family. A passkey that
doesn't return a PRF output via `navigator.credentials.get()` cannot be
used to create or unlock a Pampalo wallet. See ADR 0002.

### Auth

**Credential**:
A registered WebAuthn passkey. Identified by an opaque credential ID.
One user may have many. Each credential row holds a copy of the wrapped
DEK so any registered passkey can unlock the wallet.

**Session**:
An opaque random 32-byte hex token issued after a successful WebAuthn
ceremony, stored server-side with a 7-day expiry. Travels in an httpOnly
cookie. Distinct from the WebAuthn passkey itself: signing out invalidates
the session, not the passkey.

### Entry-point flows

**Sign in**:
Use an existing **credential** that is already enrolled to a Pampalo
wallet on the server. The wallet row already exists; this ceremony
finds it via the credential id and decrypts the stored mnemonic
ciphertext with this passkey's PRF-derived KEK.

**Recover account**:
The user has a **recovery phrase** but no enrolled passkey on this
device. The flow registers a *new* credential, encrypts the
user-supplied mnemonic under the new passkey's PRF-derived KEK, and
inserts a fresh wallet row on the server. The on-chain identity
(EVM address, envelope key, Poseidon identifier) is unchanged because
it derives deterministically from the mnemonic. Server-side this looks
identical to registration — there is no "find my existing wallet by
mnemonic" path, by design (the server never sees plaintext mnemonics,
so it cannot link a new ciphertext blob to an existing one).

_Distinct from_: "recovery integrations" in AUTH.md (the future
umbrella for MPC / Shamir / social recovery). Recover account is the
v1 mnemonic-on-paper variant of that family.

### Headless accounts (CLI / SDK)

**Agent account**:
A Pampalo identity created and custodied outside the browser, for use by a
CLI or a Node/TS script (an "agent"). Same on-chain shape as a web wallet —
one **mnemonic** deterministically producing one **EVM address**, one
**envelope key**, one **Poseidon identifier** — but it is created by the CLI
(`pampalo init`) as a *fresh, distinct identity*, not the human's web
wallet. An existing **recovery phrase** may be brought in with `pampalo
import` (explicit opt-in); the default is a brand-new mnemonic so an agent
never holds the keys that control the user's human wallet. The account has
no Convex **wallet** row and no **credential** — it is unknown to the
passkey auth model entirely. _Avoid_: "CLI wallet" (the noun is **account**,
and it is the same identity primitive as a web wallet, just headlessly
custodied).

**Account keystore**:
The encrypted-at-rest home for an **agent account**'s **mnemonic**, modelled
on `~/.ssh/`: a scrypt + AES-GCM keystore file under `~/.pampalo/accounts/`
(many accounts, like many SSH keys). Passphrase-protected by default;
unlocked once per process by the SDK (`Account.load`) and held in memory for
the run, or supplied via `PAMPALO_MNEMONIC` for ephemeral/CI use. This
deliberately reintroduces the scrypt-passphrase scheme that ADR 0002 deleted
for the web wallet — but only on the CLI surface, where there is no
WebAuthn authenticator and therefore no PRF to derive a KEK from. An
ssh-agent-style daemon for cross-invocation unlock reuse is deferred.

**Account transport**:
The pluggable channel an **agent account** uses to read chain state and
broadcast. Reuses the web app's `RpcClient` seam (`src/lib/rpc.ts`): day-1
is `DirectRpcClient` pointed at a user-supplied RPC URL; a Convex-backed
client (public catalog reads now, relayer + note hydrate once API-key auth
lands) sits behind the same interface later. Because the relayer is
Convex-gated and unreachable from a sessionless CLI, day-1 **Transfer** and
**Unshield** **self-broadcast** — linking the agent's EVM address to the
on-chain event, the very linkage the relayer exists to break. Acceptable for
a sandboxed agent identity in v1; closed once the Convex transport + relayer
path is wired.

**Proposal** (keyless agent → human account):
A future capability, distinct from an **agent account**'s self-custody. An
external agent holding a Pampalo **API key** writes a transaction *intent*
("transfer X of asset Y to recipient Z") into a queue tied to a *human's*
Pampalo wallet — it never holds key material. Because the agent cannot reach
the human's **DEK**, the intent is **ECIES-encrypted to the human's envelope
key** (public); Convex stores only that ciphertext. At approval time the
human's web wallet decrypts the intent, does coin selection, generates the
proof, and signs with the passkey — so the **privacy invariant** and ADR
0004 (server never sees a pre-broadcast unsigned tx, only an encrypted
intent) both hold. The agent proposes *blind* to the human's private balance;
feasibility is checked client-side at approval. The day-1 SDK is built to
**separate intent construction from sign+broadcast** (mirroring the web app's
`transfer-prep` → `signTransactionWithPasskey`/`relay` split) so the same
intent builder later feeds either local signing or remote proposal.
_Distinct from_: a "scoped delegated key" where the agent itself signs within
server-enforced limits — explicitly *not* the chosen model.

**SDK distribution**:
The headless stack ships as three MIT-licensed public npm packages —
`@pampalo/shared` (protocol crypto — already in the repo), `@pampalo/sdk`
(the **Agent account** core), and `@pampalo/cli` (the `pampalo` binary) —
all published from the **existing monorepo** (`pampalodotcom/pampalo`, made
public) via Changesets. They depend on one another with `workspace:*`;
Changesets rewrites those to real versions at publish time and releases in
dependency order `shared → sdk → cli`. The app keeps consuming `shared` via
`workspace:*` unchanged — no extraction, no migration, workspace dev loop
intact. The scope `@pampalo` is owned by the npm **user** `pampalo` (a user
account, not an org — the two share a namespace, so an org named `pampalo`
is blocked); public scoped packages publish free under it, and the account
can later be converted to an org with no package renames. (Three separate
repos and a dedicated SDK monorepo were both considered and rejected: once
the app repo went public, a single monorepo was the least-ceremony option.)

### Multi-chain deployment catalog

**Pampalo deployment**:
The full set of contracts that constitute a Pampalo install on one EVM
chain — the `Pampalo` contract, its four verifiers, the Poseidon2 huff
hasher, and any per-asset `IPriceOracle` adapters. Mirrored server-side
in the Convex `pampaloDeployments` table, one row per chain, FK'd to
`supportedNetworks`. Source of truth for "which contract address is
the Pampalo router on chain X?". Not to be confused with **Network**
(the generic catalog entry that also serves balance lookups for chains
where Pampalo isn't deployed).

**Retired note**:
A locally-stored note whose `deploymentAddress` is no longer the
currently-enabled **Pampalo deployment** for its chain (i.e. it was
shielded on a previous, redeployed contract version). Pampalo is
non-upgradeable (ADR 0017), so a retired note's leaf lives in the old
contract's abandoned tree and can never be spent against the current
verifiers. Retirement is **derived, not stored** — a note is retired
iff its `(networkChainId, deploymentAddress)` is absent from the live
`enabledDeployments()` set — so no per-note flag or migration pass is
needed, and any future vN redeploy retires vN-1 notes automatically.
Retired notes are **retained and visible** (read-only history), never
deleted; they are excluded from spendable-balance and the spend picker.

**Shieldable asset**:
A `(deployment, ERC-20 address)` pair currently registered in the
deployment's on-chain `Pampalo.supportedAssets` mapping with
`enabled = true`. Mirrored in the Convex `pampaloAssets` join table
with its cached oracle adapter address. Rows are write-once + flip
`enabled`, never deleted, so the audit / Sentry view can show "this
asset was disabled at …".

**Total balance**:
The dashboard's headline figure — public + private holdings summed in
USD across **mainnet** chains only. Testnet value never blends into it
(nor into its public/private chips or split bar), even when the
testnets preference is on.

**Testnet balance**:
USD value of holdings on testnet chains, public + private combined
into one figure. Priced with the same feeds as the mainnet twins, so
the number is meaningful — but it is play money and is displayed as
its own "$X.XX Testnet" secondary headline beneath the **Total
balance**, only while the testnets preference is on. Loads
independently: a stalled testnet RPC or feed never delays the mainnet
headline, and vice versa. Shows `$0.00` honestly in both directions —
an all-testnet account reads "$0.00" big with its testnet value
beneath.

### On-chain protocol (the smart-contract layer)

**Note**:
The unit of private value. A four-tuple `(asset_id, asset_amount,
owner, secret)` where `owner` is the recipient's **Poseidon
identifier** and `secret` is a per-note unlinkable field randomly
chosen by the note's creator. Notes are committed to a Pampalo
merkle tree as `poseidon2([asset_id, asset_amount, owner, secret])`
leaves. Anyone can see the leaf; only the holder of `secret` can
prove ownership in ZK and spend the note.

Pampalo stores notes across a **sequence of fixed-height trees**
(currently HEIGHT = 12, i.e. up to 2^11 = 2048 leaves per tree).
The contract rotates to a new tree when the current one fills;
historical trees remain spendable. Every note is therefore
identified by a pair: `tree_index` (which tree, monotonic) and
`leaf_index` (position within that tree). Both indices appear in
the `NoteCreated` event and travel with the note in IDB.

**Note secret**:
The `secret` field of a note. Generated by the note's *creator*
(the sender on a transfer, or the depositor on a shield), then
ECIES-encrypted to the *recipient's* **envelope key** and emitted
alongside the note's on-chain leaf. The recipient pulls it from
public chain data, decrypts with their envelope private key, and
stores it in their browser IndexedDB so they can spend the note
later. Until decrypted, no observer — including the recipient if
they haven't yet scanned — can link the note's leaf to any address.

**Receive**:
The wallet-side UX of funding the wallet from an external source. A
"Receive" flow shows the user's EVM address (and a QR), the external
sender does a plain on-chain transfer, and funds land in the user's
**public** balance. A separate "shield-on-arrival" intent can attach
to a Receive to surface a follow-up prompt once the inbound transfer
is detected — but the receipt itself is always public, because
external senders cannot generate a shield proof on the user's behalf.
User-facing copy calls this **"Deposit"** (it's the verb users
expect); internal components keep the `Receive` name to match the
on-chain layer.

**Shield**:
Public ERC-20 → new private note. The depositor approves the
Pampalo contract for the token, calls `shield(...)`, and the
contract pulls the tokens and inserts a new leaf into the merkle
tree. The depositor's EVM address is public on-chain (it's the
`msg.sender` of the shield call); the resulting note's `owner` is
a **Poseidon identifier** that may or may not be the depositor's
own. Privacy is provided by **unlinkability between the shield
event and any later transfer / unshield**, not by hiding that the
depositor used Pampalo at all.

**Transfer (Pampalo)**:
Private note(s) → private note(s), entirely inside the merkle tree.
Inputs are existing notes (spent via nullifier), outputs are new
notes (leaves added). Verified by the `transfer` ZK circuit. _Avoid_:
calling this "Send" in protocol copy — `Send` is reserved for the
client-side EVM-layer feature that transfers ERC-20 over plain
on-chain rails, no privacy.

**Unshield**:
Private note → public ERC-20. A spent input note is paid out to an
arbitrary EVM address (the holder's own, or a third party's). Verified
by the `transfer_external` ZK circuit. The recipient EVM address is
public on-chain; the link from that address back to the original
shield event is what the protocol breaks.

**Private swap**:
Private note of asset A → private note of asset B, with the trade
executing against **public Uniswap v4 liquidity** in one atomic call
(`privateSwap` → `poolManager.unlock` → `unlockCallback`). Pampalo is a
**caller** of the v4 `PoolManager`, not a hook author. The privacy
model is **ownership-private, amount-public**: the nullifier breaks the
input note's lineage and the output note's owner is hidden, but
`(assetA, assetB, amount)` is observable at the AMM — the only model
achievable against public liquidity. Value never leaves the shield (no
external recipient), so **no Monthly cap is charged** — extraction stays
gated at **Unshield**. Broadcast is **relayer-sponsored** like
**Transfer** / **Unshield** (ADR 0015) so the spender's EVM address isn't
linked to the swap; unlike those, a swap can genuinely revert on
`realized < T` if price moves before inclusion. v1 routes **ERC-20 pools
only** — native-ETH (`0xEeee…eEeE`) notes must wrap to WETH first; v4's
native `address(0)` legs are deferred. Verified by a new `swap` ZK
circuit, which mints the asset-B output note at **Target output** `T`
plus an optional same-asset asset-A change note (multi-hop routes are
supported; the path is untrusted calldata, safe only because
`input_asset`, `output_asset`, and `T` are bound in the proof).
_Avoid_: bare "Swap" — reserved for the client-side public EVM-layer
swap (`uniswap-swap.ts`), no privacy.

**Target output (`T`)**:
The fixed output-note amount a **Private swap** mints, chosen by the
spender at proof time and bound into the output commitment by the swap
circuit. Because the realized AMM output doesn't exist at proof time, it
**cannot** be committed in the proof; instead the swap is exact-input,
the contract requires `realized >= T` (so `T` doubles as the slippage /
sandwich floor — there is no separate `minOut`), and the **forfeited
surplus** `realized − T` stays in the contract's pooled asset-B balance,
unowned by any note. Consequence: a swap forfeits not just slippage but
all favourable price movement above `T`; downside is revert-protected,
upside is donated to reserves. This avoids any on-chain Poseidon — the
commitment is still computed in-circuit. See ADR for the trade-off
against on-chain note construction.

**Shield wait**:
The mandatory holding period (default 1 hour) between a user calling
`shield(...)` and the resulting note being inserted into the merkle
tree. During the wait the shielded asset is escrowed by the Pampalo
contract; no on-chain note exists yet. The shielder may **cancel and
recover the asset at any point before the shield is executed** —
including after the wait elapses, since the funds stay escrowed until
`executeShield` inserts the leaf (`cancelShield` has no unlock-time
gate; once executed, the freed storage rejects a late cancel). A
**vigilant citizen** may likewise contest up until execution.

**Finalise**:
Moving a ready pending shield — one whose **Shield wait** has elapsed —
into the pool by calling `executeShield(id)`, inserting its leaf so the
note becomes spendable. **Permissionless**: the shielder finalises their
own from the wallet, or anyone "sponsors" a finalise on **Sentry** (the
same on-chain call, a different caller paying gas). Distinct from
**Fast-track**, which _skips_ the wait rather than waiting it out.
_Avoid_: "execute" (the contract verb, not the user-facing one).

**Fast-track**:
A `BOOTH_OPERATOR_ROLE` waiver of the **Shield wait** for a vetted user.
Two on-chain forms: `executeShieldImmediate(id)` finalises one named
**Pending shield** now; the per-user monthly flag (`fastTrackAllowed`
keyed by `(user, monthKey)`) makes every shield that user queues this
calendar month land with `unlockTime = block.timestamp` — immediately
executable. Fast-tracking **skips the contest window**, so it is a
deliberate "the operator vouches for this user this month" trust
statement, not a convenience toggle. Resets each UTC month like the caps.

**Booth drip**:
A `BOOTH_OPERATOR_ROLE` event affordance for seeding attendees with a
small amount of money fast. The operator scans an attendee's **shared
address** QR and sends them **$1.00** — publicly (1 USDC to their EVM
address) or privately ($1-worth of shielded ETH to their Poseidon /
envelope). Surfaced as one-tap buttons on the otherwise-public
[`/share`] page, shown only when the viewer holds the role on that
deployment. Like **Fast-track**, it's a booth-operator power to onboard
people quickly at an event, not a general user feature.

**Monthly cap**:
The per-address USD ceiling on shielded *and* unshielded volume per UTC
month. Tracked on-chain as two independent buckets (`shieldUsage`,
`unshieldUsage`), each charged at its respective op and each bounded by
the same `effectiveCap` — the per-address override
(`addressMonthlyCapUsdCents`) if set, else `defaultMonthlyCapUsdCents`
(**$200.00**). So a user may shield up to $200 *and* unshield up to $200
in the same month; the two don't net against each other. Charged in USD
cents at the Chainlink-oracle price seen at op time; a **Contest** or
`cancelShield` refunds the shield charge inline (subject to the
same-month caveat in `_refundShieldCap`). Read via the `shieldBudget` /
`unshieldBudget` views, which mirror the on-chain charge math (including
the prior-month auto-reset) so the client slider and the contract agree.

**Pending shield**:
A queued shield awaiting unlock. Identified by an opaque `pendingId`;
the shielder, asset, amount, and leaf commitment are all stored on-chain
during the wait. Once executed the storage is freed and the leaf is
inserted.

**Shield queue**:
The set of all currently-queued shields across every active
**Pampalo deployment** — the page-level concept rendered by the
public `/sentry` route. Mirrored in the Convex `shieldQueueEntries`
table (one row per pending id per deployment). The page itself is
public read; row-level actions (`Contest`, `Fast-track`) are
role-gated by the contract, and the UI hides or reveals them based on
`hasRole(...)` reads for the connected wallet.

**Contest**:
A `VIGILANT_CITIZEN_ROLE` action that cancels a pending shield, refunding
the shielder's escrow. Used for compliance review (e.g. OFAC-listed
source addresses). Distinct from `cancelShield` which is the shielder's
own opt-out during the wait.

_Automated Contest_: a Convex cron indexes blocked addresses from
external sources (the Chainalysis on-chain sanctions oracle; Railgun's
published blocklist) into a Convex table, then scans the **Shield queue**
for any **Pending shield** whose `shielder` is blocked and calls
`contestShield(id, reason)` via the **Compliance signer** before the
**Shield wait** elapses. Because on-chain `shield(...)` is permissionless
(ADR 0007), this post-hoc contest during the wait window is the *only*
mechanism for "programmatic refusal of entry" — entry can't be blocked
at call time, only unwound before the note is inserted.

_Refund is on-chain, push-style, at contest time_: `contestShield`
calls `_refundEscrow(p.shielder, p.asset, p.amount)` inline, which
transfers the asset back to the shielder's public balance in the same
TX. The cap is refunded the same way (subject to the same-month
caveat in `_refundShieldCap`). There is no "claim refund" function
and no user action required to recover funds — the shielder's
public wallet is whole again the moment `ShieldContested` is emitted.
The wallet UI surfaces this as a past-tense status ("Contested · 0.5
ETH refunded to your wallet"), never as a call to action.

_Vocabulary note_: `encrypt` / `decrypt` are reserved for the
mnemonic-vault layer (see Encryption above). Do not use them for
shield / unshield in protocol or user-facing copy. The `commbank.eth`
upstream calls these "deposit" / "withdraw" / "encrypt" / "decrypt" —
when porting, translate at the protocol surface (methods, events,
roles, helper class names, cap accounting). Verifier contract filenames
and `circuits/{deposit,transfer,transfer_external,withdraw}/` stay
upstream-named because they're bytecode-bound.

**Gas sponsor / Relayer account**:
One of the EOAs the Pampalo backend uses to broadcast a user's
**Transfer** or **Unshield** without revealing their EVM address. Five
accounts per **sponsoring chain**, derived from a single backend
`RELAYER_MNEMONIC` at BIP44 path `m/44'/60'/0'/0/{0..4}`. The accounts
are interchangeable and selected LRU among the idle, funded subset;
concurrent broadcasts on the same chain never collide on the same
account because the acquire/release flow is gated by an atomic Convex
mutation. Pampalo's contract is permissionless on `transfer(...)` and
`unshield(...)`, so the relayer holds **no on-chain role** — its only
privilege is "has ETH to spend on gas." Relaying an **Unshield** is the
privacy win that justifies the expanded scope: the holder can withdraw
to a brand-new, **unfunded** EVM address (the relayer pays gas) instead
of needing that address to already hold ETH, which would link it. Every
relay is gated to protect the sponsor's gas: the proof bytes must be
non-empty / non-zero, a pre-broadcast `eth_call` simulation must not
revert, and the move must be within the user's **monthly cap**. See
`TRANSFERS.md` and ADR 0015 (which supersedes the transfer-only scope of
ADR 0010).
_Avoid_: granting the relayer pool any on-chain role — compliance
contests are signed by the separate **Compliance signer**, never these
accounts.

**Compliance signer** (Sentry account):
A single dedicated EOA the Pampalo backend uses to sign automated
`contestShield(...)` calls. Derived from the **same** `RELAYER_MNEMONIC`
but at a **distinct index past the relayer pool** (`m/44'/60'/0'/0/5`),
and the only backend account granted `VIGILANT_CITIZEN_ROLE`. Kept
separate from the **Relayer accounts** (0–4) so the gas-sponsor identity
stays role-less and is never publicly linkable to compliance
enforcement. Drives the **automated Contest** path. See ADR 0016.

**Sponsoring chain**:
A `pampaloDeployments` row with `sponsoringTxs = true`. Means the
backend operates a relayer pool for that chain and the user-side
transfer UI defaults to private (gas-paid-by-relayer) broadcasting.
Defaults to `false` everywhere except Base Sepolia at seed time;
flipping the flag on a new chain is a manual operator decision.

**Self-broadcast fallback**:
The user-side path where the wallet pays gas and signs the
`Pampalo.transfer(...)` call directly via the existing
`signTransactionWithPasskey` flow. Reached either at chain-pick time
(the chain isn't a sponsoring chain) or at submit time (the relayer
pool is busy / exhausted). The transfer still works but the user's
EVM address is publicly linked to the on-chain transfer event —
breaking the EOA-anonymity property the relayer otherwise provides.
The UX always surfaces this with an explicit confirm dialog before
proceeding; never silent.

**Affordability preflight**:
The client-side check that blocks a confirm/review button when the
user's wallet can't cover a **self-broadcast**. A self-broadcast costs
the user `value + gasLimit × maxFeePerGas` in native ETH — the exact
amount the node reserves up-front (not an estimate; Pampalo uses fixed
per-flow `gasLimit` constants, never `eth_estimateGas`, per ADR 0004).
The preflight reads the chain's native balance (and, for an ERC-20
send, the token balance) via `usePublicBalance` and disables submission
with a specific "need ≈X, have Y" message when short. It applies to
**public Send**, **Shield** (always self-signed), and the
**self-broadcast fallback** of Transfer / Unshield — **never** the
relayed path, which costs the user zero native ETH (a **sponsoring
chain**'s relayer pays the gas). A broadcast-time error normaliser is
the backstop for the residual race (30s-stale balance, gas spike):
known RPC strings (`insufficient funds`, nonce conflicts) map to
friendly copy, with the raw error kept behind a details toggle.

### Private payments (proof-of-payment)

**Private payment**:
A purchase where the buyer pays a merchant with a Pampalo note instead
of a public ERC-20 transfer, and a consuming contract accepts that
payment the way it would accept an ERC-20. Two-step and non-atomic
(model A): (1) the buyer issues an ordinary **Transfer** creating one
note owned by the merchant's **Poseidon identifier** for `(asset,
amount)`; (2) after the note is indexed the buyer builds a **payment
proof** that the note exists in a known root, and the consuming contract
settles it. The merchant genuinely receives a spendable note; the proof
is a separate single-use coupon that gates the good. _Distinct from_
**Transfer** (the payment leg itself) and **Unshield** (value out to a
public address). _Avoid_ "redemption" as the feature name — that reads
as NFT-specific; the mechanism is generic payment acceptance.

**Payment proof** (redeem circuit):
The membership proof a buyer generates to spend a private payment. Built
by the `redeem` circuit (`circuits/redeem/`) — a single-input, no-
balance, no-spend cousin of `withdraw`. Eight public inputs, in order:
`root`, `redeem_nullifier`, `merchant_id`, `asset_id`, `asset_amount`,
`recipient`, `consumer`, `reference`. The buyer can build it because
they *created* the merchant's note (they know its `secret`), but can
never *spend* it (they don't know the merchant's `owner_secret`).

**Redeem nullifier**:
The nullifier burned when a private payment is settled. Domain-separated
from the spend **Nullifier** (`REDEEM_DOMAIN =
keccak256("PAMPALO_REDEEM_V1") mod p`, mirrored in
`pum_lib::compute_redeem_nullifier` and `shared/constants/zk.ts`) so a
redeem cannot grief the merchant's later spend of the same note, or vice
versa. Deliberately **excludes** `recipient`, `consumer` and
`reference`, so one payment note is redeemable at most **once, ever,
globally**.

**Payments singleton** (`PampaloPayments`):
A permissionless, standalone contract that is the shared registry of
**redeem nullifiers**. Its `verifyAndBurn` checks the root via the live
Pampalo deployment's `isKnownRoot`, verifies the payment proof against a
dedicated `RedeemVerifier`, binds every public input to the caller's
expectations, and burns the redeem nullifier — all on behalf of any
consuming contract. It **never moves value** and never writes to the
Pampalo core (reads roots only). The shared registry is what makes a
payment single-use across *all* consumers, not just one storefront.

**Private payment acceptor**:
The inheritable base (`PrivatePaymentAcceptor`) that lets any contract
accept a private payment in one line at the top of its purchase flow
(`_acceptPayment(...)` / `_acceptPrivatePayment(...)`), mirroring how it
would pull an ERC-20. Holds the vendor's `merchantId` config and the
`privateEnabled` **kill switch**: the deploying vendor (the
`privatePaymentAdmin`) can disable private payments at any time, after
which the private branch reverts and only the public ERC-20 branch
works.

**Consumer binding**:
The `consumer` public input on a **payment proof**, pinned to the
contract allowed to settle it. The **payments singleton** requires
`msg.sender == consumer`, which is what defeats a mempool watcher
copying the proof and calling `verifyAndBurn` directly to burn the
nullifier without delivering (a DoS the atomic Pampalo paths can't
suffer). Paired with `recipient` (delivery target, frontrun-safe) and
`reference` (an opaque vendor-defined field — item id, cart hash — that
blocks same-price item-swap griefing).

### Naming / directory (Ethereum L1 / ENS)

**Pampalo username**:
`name.pampalo.eth` — an opt-in, paid ENS subname (NameWrapper-wrapped,
deployed on Ethereum **L1** because that is where the ENS registry and
NameWrapper live) that publicly resolves to a recipient's **Envelope
key** and **Poseidon identifier** via a custom Pampalo resolver. A
human-readable receiving handle: a sender types `alice.pampalo.eth`
instead of pasting two hex blobs, then has exactly what's needed to
ECIES-encrypt a note secret and set the note `owner`. Deliberately does
**not** publish the **EVM address** (the resolver's `addr()` is left
unset) — it is a private-money receiving handle, not a public-payment
one. Records are written atomically at registration and are mutable by
the current subname-NFT owner. Minting price and an address-allowlist
discount root are tuned by `FINANCE_MANAGER_ROLE`; the Safe holds
`DEFAULT_ADMIN_ROLE`. See ADR 0012.
_Avoid_: bare "username" or "ENS name" (the user may hold unrelated
ENS names); "envelope address" / "poseidon key" (the canonical nouns
are **Envelope key** and **Poseidon identifier**).

## Relationships

- A **mnemonic** deterministically produces one **EVM address**, one
  **envelope key**, and one **Poseidon identifier**.
- A **Pampalo username** publishes a mnemonic's **Envelope key** and
  **Poseidon identifier**; the same mnemonic's **EVM address** is
  deliberately withheld from the directory.
- A **wallet** has exactly one **mnemonic** and one or more **credentials**.
- Each **credential** carries its own wrapped **DEK**; the wallet's
  **mnemonic** is encrypted once with the **DEK**.
- A **session** points to a **user**, not to a specific **credential** —
  any registered credential for that user can establish a session.

## Flagged ambiguities

- "Address" is overloaded — the user has three: **EVM address** (public,
  on-chain handle), **Envelope key** (ECIES recipient), **Poseidon
  identifier** (ZK-note recipient). Always say which. A **Pampalo
  username** resolves to the latter two and never the **EVM address**.
- "envelope address" / "poseidon key" were used for the values a
  **Pampalo username** returns — resolved: the canonical nouns are
  **Envelope key** (a secp256k1 public key, not an address) and
  **Poseidon identifier** (an identifier, not a key).

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
store it locally, and use it to spend the note. Derived on a dedicated
HD path (separate from the EVM signing path) so the corresponding private
key can be cached in memory for background note-scanning without also
giving an attacker the ability to sign Pampalo writes. See ADR 0009.

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

**Shield wait**:
The mandatory holding period (default 1 hour) between a user calling
`shield(...)` and the resulting note being inserted into the merkle
tree. During the wait the shielded asset is escrowed by the Pampalo
contract; no on-chain note exists yet, so the shielder may cancel and
recover the asset, and a **vigilant citizen** may contest.

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
**Transfer** without revealing their EVM address. Five accounts per
**sponsoring chain**, derived from a single backend `RELAYER_MNEMONIC`
at BIP44 path `m/44'/60'/0'/0/{0..4}`. The accounts are interchangeable
and selected LRU among the idle, funded subset; concurrent transfers
on the same chain never collide on the same account because the
acquire/release flow is gated by an atomic Convex mutation. Pampalo's
contract is permissionless on `transfer(...)`, so the relayer holds
no on-chain role — its only privilege is "has ETH to spend on gas."
See `TRANSFERS.md` and ADR 0010.

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

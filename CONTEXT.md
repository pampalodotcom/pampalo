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
encryption target when another user sends this user a note.

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

## Relationships

- A **mnemonic** deterministically produces one **EVM address**, one
  **envelope key**, and one **Poseidon identifier**.
- A **wallet** has exactly one **mnemonic** and one or more **credentials**.
- Each **credential** carries its own wrapped **DEK**; the wallet's
  **mnemonic** is encrypted once with the **DEK**.
- A **session** points to a **user**, not to a specific **credential** —
  any registered credential for that user can establish a session.

## Flagged ambiguities

- "Address" is overloaded — the user has three: **EVM address** (public,
  on-chain handle), **Envelope key** (ECIES recipient), **Poseidon
  identifier** (ZK-note recipient). Always say which.

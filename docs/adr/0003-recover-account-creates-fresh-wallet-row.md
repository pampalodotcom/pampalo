# Recover account creates a fresh wallet row

Recover account — the v1 path for a user who has a **recovery phrase** but
no enrolled passkey on the current device — registers a new credential and
inserts a **new wallet row** on the server, encrypted under the new
passkey's PRF-derived KEK. The server cannot detect that the user already
has a wallet row decrypting to the same recovery phrase, and per
[ADR 0001](./0001-encrypted-mnemonic-and-nothing-else.md) must not be able
to. Server-side, the flow is indistinguishable from `registerNewWallet`;
the difference is purely client-side (the mnemonic is the user's existing
one, not freshly generated).

## Why not dedupe server-side

Every dedupe primitive we considered leaks the kind of correlatable data
ADR 0001 rules out:

- **Mnemonic fingerprint** (`hash(mnemonic)`) — gives the server a stable
  per-identity handle that survives across recoveries, exactly the
  "behavior signal" the schema is supposed to refuse.
- **Address-keyed lookup** (server stores EVM address) — leaks the
  on-chain handle, the most direct version of the same leak.
- **Client-asserted "existing userId"** — would require the recovering
  client to know the original `userId`, which it doesn't (the mnemonic
  is the only thing the user has).

So duplicate wallet rows are accepted as the cost of the privacy posture.

## Consequences

- **Two wallet rows per on-chain identity per recovery event.** The
  server learns "another wallet was created" with no correlation back to
  the original; the new row is opaque ciphertext as far as the server is
  concerned. The user's on-chain identity (EVM address, envelope key,
  Poseidon identifier) is unchanged because all three derive
  deterministically from the mnemonic.

- **Encrypted preferences don't merge across recoveries.** The
  `userPreferences` row is keyed by `userId`; a recovery produces a new
  `userId`, so preferences start fresh on the recovering device. The
  Recover form surfaces this inline as a one-line note
  ("Your saved app preferences won't carry over from your other
  device.") — it's the only user-observable consequence of the
  duplicate-row reality, and the user can act on it (re-set their
  currency, default chain, etc.).

- **The new passkey is labeled `Pampalo (Recovered)`** via the WebAuthn
  `user.displayName` parameter at registration. This label lives in the
  OS keychain / passkey manager only — we do not store it server-side
  (ADR 0001 forbids `credentials.label`). The label exists so that a
  user with both an original and a recovered passkey in the same OS
  keychain (e.g. recovered on the same browser after losing the cookie
  but with the synced passkey still present) can tell them apart in the
  iOS / macOS / Google passkey picker.

- **A future "manage passkeys" UI cannot show this label.** Per ADR
  0001, we don't read the label back from the server. If the label
  matters in a Pampalo-rendered view someday, that view would have to
  fetch it from the authenticator at sign-in time and cache it
  client-side — the server stays out of it.

- **A future server-side dedupe attempt should land here first.** This
  ADR exists so the engineer who notices "we have two wallet rows for
  the same person on the server, that's a bug, let me fix it" reads
  ADR 0001 before reaching for a fingerprint column.

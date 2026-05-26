# Encrypted mnemonic and nothing else

The Convex database stores the encrypted **mnemonic** plus the public WebAuthn
material needed to verify a ceremony (`credentialId`, `publicKey`, `counter`,
`transports`) plus opaque server primitives (random `userIdBytes`, session
`token` + `expiresAt`). **Nothing else on a user-scoped table.** No
user-supplied free text, no behavior timestamps, no device labels. The
plaintext mnemonic never leaves the client.

This is the public privacy promise — "the server cannot link a user's notes
to their EVM address; recipient identity for a note is unlinkable on-chain"
— made enforceable by removing every column the server could correlate.

## Consequences

The current schema must drop:

- `users.displayName`
- `credentials.label`, `credentials.lastUsedAt`
- `wallets.mnemonicConfirmedAt`
- `credentials.prfSalt` (dead data — client uses a single deterministic
  global salt; per-credential salt rotation isn't a thing we do)
- `wallets.protectionScheme`, `wallets.encryptedJson` (see ADR 0002 —
  passphrase scheme removed entirely)

UX that previously leaned on those columns moves client-side: backup-status
hints become per-device localStorage flags, "manage passkeys" identifies
credentials by their credentialId prefix rather than by a server-stored
label. The trade-off is taken deliberately — a label column is the kind of
thing the next engineer will want to add back, and they should read this
before doing so.

# PRF required, no passphrase fallback

Account creation and unlock require the WebAuthn PRF extension. If a
passkey provider doesn't return a usable PRF output via
`navigator.credentials.get()`, Pampalo refuses to create the wallet (and
refuses to unlock an existing one) — there is no scrypt-passphrase
fallback. Validated 2026-05-19: Apple Passkeys and 1Password passkeys
both produce reliable PRF output on pampalo.com.

## Consequences

The passphrase scheme is removed end-to-end: `wallets.protectionScheme`,
`wallets.encryptedJson`, the entire `passphrase` branch in
`convex/auth.ts` / `authNode.ts` / `http.ts`, `PassphraseEntry`,
`PassphraseRequiredError`, `unlockWithPassphrase`, and
`completePassphraseRegistration` all go away. Detection becomes a hard
gate: registration runs the `create() → get()` sequence; if `get()`
returns no PRF output, abort and show the help screen rather than
collecting a passphrase.

The trade-off: any user whose only passkey provider lacks PRF cannot use
Pampalo. As of the validation date that's a small population (Firefox,
some YubiKey-on-iOS configurations); the help screen tells them which
providers do work.

### Private Pampalo

Railgun meets Infinex - Signal for money.

#### Domains

pampalo.com - prod

dev.pampalo.com - dev

#### TODO

- **WebAuthn `largeBlob` extension as a second non-PRF fallback.** Today, when
  a passkey provider doesn't expose PRF (notably 1Password on iOS as of mid
  2026), we fall back to a passphrase-protected wallet. `largeBlob` would
  let us store a random key inside the credential itself — no passphrase
  prompt, syncs with the passkey across the user's devices, and keeps the
  "magic, single-step" UX. Worth revisiting once 1Password's largeBlob
  support is solid on iOS Safari. See AUTH.md §3 / §6 for context on the
  current envelope scheme; the largeBlob flow would replace the
  passphrase-derived KEK with a randomly generated DEK stored in the
  credential's `largeBlob` slot.

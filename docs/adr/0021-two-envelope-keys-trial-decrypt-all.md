# Two envelope keys (shared/isolated); Sync trial-decrypts every key

A mnemonic produces **two** ECIES **envelope keys**, not one: the **shared
envelope** at BIP44 path 0 (`m/44'/60'/0'/0/0`, *identical to the EVM
key*) and the **isolated envelope** at the Pampalo slot-420 path
(`m/44'/60'/0'/0/420`, a dedicated leaf). Which one a chain uses is fixed
per deployment by `separateDerivationKey`: false → shared, true (and the
canonical default for an unset value, `!== false`) → isolated. The split
exists so a future "hot Sync" compromise of the always-warm testnet
shared key (which equals the EVM signing key) cannot also decrypt mainnet
notes — mainnets derive their envelope from the isolated path that the
testnet key cannot reach (hardened HD tree → sibling leaves are
non-derivable from each other).

**Decision:** `separateDerivationKey` decides only which envelope a
*recipient publishes* (in their QR/share link) and a *sender encrypts to*.
It must **not** gate decryption. Every note-scanning **Sync** trial-decrypts
each on-chain payload against **all** envelope private keys the mnemonic
yields (today: shared + isolated, newest scheme first), keeping the one
that decrypts and whose `owner` matches the wallet's Poseidon identifier.
A wallet therefore recovers its notes regardless of which envelope the
sender chose, and adding a future envelope path is a one-line change in
`deriveEnvelopePrivKeys` (the single source of truth for "keys that can
decrypt our notes"), consumed identically by the web Sync
(`sync-shield-notes.ts`) and the SDK (`sdk/src/sync.ts` `tryDecrypt`).

## Consequences

Trial-decrypting N keys per payload is N ECIES attempts instead of one;
negligible at current scale and the cost of robustness. Because receipt no
longer depends on the sender picking the "right" envelope, the
`separateDerivationKey` default disagreements that previously existed
across the stack are downgraded from "note never arrives" to cosmetic —
but we still unify them to `!== false` (isolated) so a recipient publishes,
and a sender targets, the same key. The shared envelope being the EVM key
means a leaked path-0 key on a shared-envelope chain leaks both spend
authority and note-decryption there; isolation contains that to testnet.

## Motivation (the bug this records)

The web wallet's Sync (`sync-shield-notes.ts`) derived and trial-decrypted
with the **shared key alone**. On Base mainnet (`separateDerivationKey:
true`) every inbound note is encrypted to the **isolated** envelope, so all
of them silently failed to decrypt — a private `/share` transfer "never
arrived." The SDK was already correct (it fed both `spendPrivKey` and
`isoPrivKey` into `tryDecrypt`); only the web path was single-key. The fix
threads the full key set through every web scan path and bumps the IDB sync
cursor (`v2 → v3`) to force one full re-scan so previously-skipped
isolated-envelope notes are recovered.

## Rejected alternatives

- **Flag-gated single-key decrypt** (derive only the envelope the
  deployment's `separateDerivationKey` selects, decrypt with just that).
  Minimal work per payload, but it is exactly the shape that caused the
  bug: any disagreement between the key a sender used and the key a
  scanner derives drops the note with no error. Trial-decrypt-all removes
  that entire failure class.
- **Single envelope key everywhere** (drop the isolated path). Simpler, but
  reunites mainnet note-decryption with the hot testnet spend key — the
  blast radius the isolated path exists to contain.
- **Require `separateDerivationKey` on every deployment** (non-optional
  schema). Removes the unset ambiguity at the source, but needs a schema
  migration + backfill for a case that `!== false` + trial-decrypt-all
  already render harmless.

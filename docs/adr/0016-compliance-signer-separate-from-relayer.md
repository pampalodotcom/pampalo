# Automated contests are signed by a dedicated Compliance signer, not the relayer pool

The automated compliance path (scan the **Shield queue** for blocked
shielders, call `contestShield(id, reason)` before the wait elapses)
needs a backend EOA that holds `VIGILANT_CITIZEN_ROLE`. The relayer pool
is the obvious candidate — it already exists, is funded, and is derived
from `RELAYER_MNEMONIC`. We deliberately do **not** use it.

The decision: derive **one** additional account from the same
`RELAYER_MNEMONIC`, at the index immediately past the relayer pool
(`m/44'/60'/0'/0/5`), grant it `VIGILANT_CITIZEN_ROLE`, and use it solely
to sign automated contests. Relayer accounts `0..4` remain role-less.

## Why not reuse the relayer pool

`CONTEXT.md` defines the relayer's privilege as exactly "has ETH to spend
on gas" and nothing more — it is permissionless precisely so a relayer
key compromise can't do anything a stranger couldn't already do. Granting
that pool `VIGILANT_CITIZEN_ROLE` would:

- **Doxx the gas payers as enforcers.** Every `ShieldContested` event
  names `msg.sender`. If that's a relayer account, observers can fingerprint
  the relayer set and correlate it with the transfers/unshields it sponsors.
- **Conflate two trust levels.** A leaked relayer key would gain the power
  to cancel arbitrary pending shields, not just waste gas.

A single dedicated signer keeps separation of duties while still being
**one secret to provision** (same mnemonic, different index) — the
operational simplicity that made one mnemonic attractive in the first
place, without the coupling.

## What we picked over

- **Reuse relayer accounts 0–4.** Simplest, zero new key. Rejected for
  the doxxing + trust-conflation reasons above.
- **A wholly separate `COMPLIANCE_MNEMONIC`.** Strongest isolation (a
  relayer-secret compromise can't contest at all). Rejected for v1 only
  on operational cost: a second secret to store, rotate, and fund. The
  index-split keeps a clean upgrade path — if we later want hard key
  isolation we move index 5 to its own secret with no on-chain change
  beyond re-granting the role.

## Consequences

- **One role grant at deploy/seed time.** The deployer grants
  `VIGILANT_CITIZEN_ROLE` to the index-5 address per deployment.
- **The signer must stay funded** for gas like any relayer account, but
  is acquired/released outside the relayer LRU pool so a contest never
  competes with a user broadcast for an account.
- **Manual contests from the `/sentry` UI are unaffected** — those are
  signed by whichever human wallet holds the role, as today.

## Related

- `docs/adr/0007-no-shield-role-contest-replaces-it.md` — why contest
  (not an allowlist at shield time) is the compliance primitive.
- `docs/adr/0015-relayer-also-sponsors-unshield.md` — the relayer scope
  this one deliberately keeps the contest power *out* of.
- `CONTEXT.md` — **Compliance signer**, **Contest** (automated path).

# Pampalo usernames via L1 NameWrapper subnames

We will offer **Pampalo usernames** — opt-in, paid `name.pampalo.eth` ENS
subnames that resolve to a recipient's **Envelope key** and **Poseidon
identifier**, so a sender can type `alice.pampalo.eth` instead of pasting
two hex blobs. Issued by a custom registrar that mints NameWrapper
subnames under a wrapped `pampalo.eth` and writes the records into a
custom resolver. Deployed on **Ethereum L1** — the natural home, since the
ENS registry and NameWrapper live there and L1 resolution needs no gateway.
This is a separate deployment from `Pampalo.sol` (which stays on Base).

## Considered options

- **Chain.** L1 NameWrapper (chosen) vs a Base L2 registrar (durin) vs
  offchain CCIP-Read with records in Convex. L2/offchain are far cheaper
  per name, but a paid, 10-year, NFT-backed name is ENS-native and wants
  canonical on-chain resolution with no gateway dependency. We accepted
  higher per-registration gas for that simplicity and durability.
- **Privacy posture (the notable trade-off).** A public resolver makes a
  username resolve to a **fixed, world-readable, reused-forever** Envelope
  key + Poseidon identifier. The privacy-preserving alternative is
  ERC-5564-style stealth meta-addresses (fresh per-payment identifier). We
  chose the static public directory because it is **opt-in and purchased**:
  a user who buys a username is electing to publish a permanent receiving
  handle. Both values are public material by design, and on-chain note
  leaves stay opaque (the note `secret` protects them), so a static
  directory does not let an observer enumerate a user's notes. It does,
  however, make the *receiving identity* globally linkable — acceptable
  only because it is a deliberate, paid choice, not the default.

## Consequences

- The resolver deliberately leaves `addr()` unset: the directory publishes
  Envelope key + Poseidon identifier, never the **EVM address**.
- Child expiry is capped by the parent's: `pampalo.eth` must stay
  registered ≥ the longest-lived child, and parent renewals keep children
  alive.
- Records are set at registration and mutable by the current subname-NFT
  owner (re-key / re-point after transfer).
- Access control mirrors `Pampalo.sol`: the Safe holds
  `DEFAULT_ADMIN_ROLE`; `FINANCE_MANAGER_ROLE` tunes the minting price and
  the address-allowlist discount merkle root.
- Open for a follow-up decision before mainnet: NameWrapper fuse policy
  (v1 keeps the parent in control — mildly custodial — rather than
  emancipating names).

# Pampalo is non-upgradeable; redeploys are clean breaks, versioned on-chain

`Pampalo.sol` is deployed as a plain contract — no proxy, no upgrade
pattern. A new version means a **new address and a fresh merkle tree**;
there is no migration of notes, queue, nullifiers, caps, or roles. We make
this explicit and manage it deliberately rather than pretending otherwise.

## The decision

1. **No upgradeability.** No proxy/delegatecall, no `selfdestruct`-and-
   redeploy. Each deploy is an independent contract.
2. **Redeploys are clean breaks.** State on the old contract (private
   notes in its tree, escrowed pending shields, monthly-cap usage,
   nullifiers, role grants) is **abandoned**. On testnet this is
   acceptable; users re-shield. On a future mainnet, the runbook's
   drain-first step (unshield + cancel everything on the old contract
   before repointing) becomes mandatory, not optional.
3. **Versioned by an on-chain constant.** `string public constant VERSION`
   in the contract (semver). A MAJOR bump signals a breaking redeploy. It's
   readable on-chain and recorded in the deployment ledger so "which
   contract/behaviour is live" is always answerable.
4. **The catalog is the switch.** The client only ever talks to the address
   in the Convex `pampaloDeployments` row; repointing that row *is* the
   cutover. `seedAll` detects the address change and **wipes the old
   deployment's indexed children** + resets the indexer cursor.

## Why not a proxy / upgradeable contract

- **The merkle tree is the hard part.** Pampalo's value lives in an
  append-only Poseidon tree. A storage-preserving proxy upgrade would keep
  the tree — but most of our changes (verifier swaps, tree-shape changes)
  aren't storage-compatible anyway, and a proxy adds a permanent
  admin-can-rug surface that contradicts the trust model. For a ZK privacy
  pool, an immutable contract per version is the more honest posture.
- **We're pre-mainnet.** Clean-break redeploys on testnet are cheap and
  fast; paying for upgradeability before the contract surface stabilises
  would be premature.

## The mandatory wipe (correctness, not housekeeping)

`pampaloDeployments` is keyed by `networkId` — one row per chain — so a
re-seed *reuses the row* and swaps the address. The old contract's indexed
children stay attached, and `pampaloLeaves` is keyed by
`(deploymentId, epoch, leafIndex)`. The new tree restarts at `(0,0)`, so a
new leaf 0 **collides** with the stale old leaf 0; the idempotent upsert
skips it, the client rebuilds a corrupted tree mirror, and transfer/unshield
proofs break. So wiping `pampaloLeaves` / `shieldQueueEntries` /
`transferNotes` / `pampaloActivity` on an address change is required for
correctness. `seedAll` does it automatically (only when the address
differs) and logs the counts.

## Consequences

- **A documented runbook is load-bearing**, not optional — see
  `DEPLOYMENT.md`. Miss a mirror site or the role re-grant and you get a
  silent address mismatch or a dead compliance bot.
- **Roles are per-contract.** The deployer gets all roles via the
  constructor; the compliance signer's `VIGILANT_CITIZEN_ROLE` must be
  re-granted every redeploy (`scripts/grant-roles.ts`). Relayer/compliance
  EOAs are deterministic from `RELAYER_MNEMONIC`, so their funding persists.
- **Clients hold stale local state.** A user's IDB still has old-tree
  notes after a redeploy. **Superseded by ADR 0018:** those notes are no
  longer cleared — they auto-retire (derived from the deployment address),
  stay as read-only history, and `/clear` is not part of the cutover.
- **Reversal cost:** adopting upgradeability later means re-architecting
  around a proxy + committing to storage-layout discipline forever. Staying
  non-upgradeable keeps each version a clean, auditable artifact.

## Related

- `DEPLOYMENT.md` — the redeploy runbook this ADR governs.
- `docs/adr/0016-compliance-signer-separate-from-relayer.md` — the role
  re-grant target.
- `CONTEXT.md` — **Pampalo deployment**.
- `SHIELD_FLOW.md` — "previous contract left orphaned" note this formalises.

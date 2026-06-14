# Retired notes are withdrawable via a client-side unshield against the old contract

A user can withdraw a **Retired note** (a note on a previously-deployed,
now-redeployed `Pampalo` contract) back to their own public address. The web
client rebuilds the *old* contract's merkle tree from a **server-side leaf
snapshot** (`archivedLeaves`, taken at cutover) and generates a normal
`unshieldBundled` proof against the old contract. This is **not** a migration
and adds **no contract surface**; it refines ADRs 0017/0018, which had framed
retired notes as abandoned and read-only.

## The decision

1. **Withdrawal, not migration.** The deployed old contract is immutable
   (ADR 0017) and its only value-exit is `unshield`/`unshieldBundled` to a
   public address. So there is no honest "move straight into the new contract
   privately" path out of an already-deployed contract — value must transit
   the public layer. We therefore ship **"Withdraw to wallet"** (exit the
   retired note to the user's currently-signed-in EVM address); re-shielding
   into the current deployment is the user's normal Shield flow, layered on
   later if wanted. Surfaced as a **Withdraw** button on the **Previous
   deployments** card (the ADR 0018 surface).

2. **The old tree is rebuilt from an archived leaf snapshot, not the live
   mirror.** The web wallet normally builds its tree from the Convex leaf
   mirror (`leavesForChain`), but the cutover **wipes** the old deployment's
   `pampaloLeaves` — required for correctness because `seedAll` *reuses the
   one `pampaloDeployments` row per chain*, so the new tree's leaf 0 would
   otherwise collide with the stale old leaf 0 (ADR 0017). We cannot simply
   "leave the leaves in place" for that same reason. Instead the archive step
   (ADR 0018) gains a **`archivedLeaves`** table: at cutover it snapshots the
   old deployment's `(epoch, leafIndex, leafCommitment)` rows into it **before**
   the wipe — collision-safe because it's a separate table keyed by the old
   *address*, not the reused `deploymentId`. The client rebuilds the old tree
   from that snapshot; the full set's root equals the old contract's current
   root, which is in its `isKnownRoot` window, so the proof verifies. This
   supersedes ADR 0018's "leaves are not archived" call, whose premise ("a
   retired note is never proven") this ADR changes.

3. **Circuit-compatible bumps only (G1).** The web unshield path uses
   `unshieldBundled` → the **`transfer_external`** circuit / the old contract's
   `transferExternalVerifier`. A proof is only accepted if the client's bundled
   `transfer_external` circuit shares that verifier's vk. The web app bundles
   **one** circuit version, so withdrawal is offered **only** when the old
   deployment's `transfer_external` vk matches the current bundled circuit (the
   common case — e.g. 1.x → 2.0.0 was Solidity-only). A **circuit-breaking**
   redeploy leaves its notes read-only retired, as before; recovery there is
   the mainnet drain-before-cutover runbook step. The gate needs two new fields
   on `archivedDeployments`: `fromBlock` (provenance) and a `circuitVkHash`
   (hex of `circuits/transfer_external/target/vk_hash`).

4. **Retirement wind-down lifts the cap problem at the source.** Notes are
   atomic (`unshieldBundled` exits a note's *whole* amount), so a single note
   worth more than the old contract's monthly **unshield** cap could never
   exit. We dissolve this operationally rather than in the UI: at cutover the
   runbook calls, **on the old contract**, `weAreFull()` (halts further
   deposits into the dead contract — it does *not* gate withdrawals) and
   `setDefaultMonthlyCap(<huge>)` (lifts the unshield ceiling; deployer still
   holds `FINANCE_MANAGER_ROLE` there). There is no compliance cost — it is a
   deprecated-contract drain to the user's own public address, not a fresh
   crossover. The only remaining batching is the circuit's input-note limit.

   The wind-down also has a **correctness** role: the `archivedLeaves`
   snapshot's root must equal the old contract's current root, so the snapshot
   must be taken when the old tree is **frozen** — `weAreFull()` *and* the
   pending-shield queue drained (no `executeShield` can land a leaf after the
   snapshot) *before* `seedAll`'s archive step.

5. **Self-broadcast; no relayer plumbing.** A withdrawal deliberately exits to
   the user's own public address, so the relayer's address-unlinking value is
   moot. The existing `private-broadcast` self-broadcast path submits the tx
   against the old contract; the user pays gas. The relayer is not extended to
   target old contracts.

## Considered and rejected

- **Leave the leaves in `pampaloLeaves` (no wipe).** The reused per-chain
  deployment row makes the live tree collide with the old one — corrupts the
  *current* tree, not just history. The only safe "leave in place" variant is
  a **multi-row** model (retire the old row `enabled:false`, insert a new row),
  which ripples through every `by_networkId.unique()` site *and* requires
  rewiring the retired-history UI off the existing archive tables. More churn
  than extending the archive. Deferred as the long-term clean model (pairs with
  native migration / B2).
- **Client-side chain re-scan (`eth_getLogs` of `LeafInserted`).** Works even
  for already-wiped deployments, but `RpcClient` has no log-fetch (all chain
  reads are server-proxied today), so it's net-new capability + a full-history
  scan per withdraw. The `archivedLeaves` snapshot reuses the existing archive
  step and is cached. Trade-off: only deployments retired *after* this ships
  get a snapshot, so the already-wiped v1 stays read-only (acceptable — same
  "deploy before cutover" gate ADR 0018 carries).
- **Native private migration (new contract surface).** Impossible *out of* the
  already-deployed contract (immutable, no successor-transfer path), and even
  for future versions it still leaks the spend-old/create-new correlation; the
  only real win would be cap exemption. Deferred.
- **G2 — bundle every historical circuit.** Support withdrawal across
  circuit-breaking bumps by retaining all old proving artifacts. Maximal, but
  pays for a case that hasn't shipped; revisit if a circuit-breaking redeploy
  is ever planned.

## Consequences

- **New `archivedLeaves` table + two new `archivedDeployments` fields**
  (`fromBlock`, `circuitVkHash`), all written by `seedAll`'s archive step.
  They must be deployed **before** the next cutover (same gate as ADR 0018) or
  the wipe runs without snapshotting and those notes stay read-only — degrades
  safely.
- **The retirement runbook gains two old-contract admin calls** (`weAreFull()`
  + `setDefaultMonthlyCap`) and an ordering rule (freeze the tree before the
  archive snapshot). `DEPLOYMENT.md` records them.
- **"Read-only history" wording in ADR 0018 / the card is refined** — retired
  notes are withdrawable-but-not-spendable-in-protocol. The ADR 0018 *spend*
  filter is unchanged (retired notes still never enter transfer/unshield
  against the *current* deployment); withdrawal acts against the *old* one.
- **B2 ("Move to new deployment," auto re-shield)** is explicitly out of scope
  here — it is B1 (this) composed with the normal Shield flow, and re-entry is
  still subject to the *new* contract's shield cap + wait + contest window.

## Related

- `docs/adr/0017-non-upgradeable-clean-break-redeploys.md` — immutability +
  the leaf-collision wipe (and reused per-chain row) this works around.
- `docs/adr/0018-retired-note-handling.md` — the retire model + archive step +
  Previous-deployments surface this extends; its "read-only"/"leaves not
  archived" framing is refined here.
- `CONTEXT.md` — **Retired note**, **Retired-note withdrawal**.
- `DEPLOYMENT.md` — the wind-down calls + freeze-before-snapshot ordering.
- `docs/plans/0022-retired-note-withdrawal-implementation.md` — the build plan.

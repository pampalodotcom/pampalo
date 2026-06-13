# Retired notes are withdrawable via a client-side, chain-sourced unshield

A user can withdraw a **Retired note** (a note on a previously-deployed,
now-redeployed `Pampalo` contract) back to their own public address —
without re-shielding being involved. The web client rebuilds the *old*
contract's merkle tree directly from chain events and generates a normal
`unshield` proof against the old contract. This is **not** a migration and
adds **no contract surface**; it refines ADRs 0017/0018, which had framed
retired notes as abandoned and read-only.

## The decision

1. **Withdrawal, not migration.** The deployed old contract is immutable
   (ADR 0017) and its only value-exit is `unshield` to a public address.
   So there is no honest "move straight into the new contract privately"
   path out of an already-deployed contract — value must transit the public
   layer. We therefore ship **"Withdraw to wallet"** (exit the retired note
   to the user's currently-signed-in EVM address); re-shielding into the
   current deployment is the user's normal Shield flow, layered on later if
   wanted. Surfaced as a **Withdraw** button on the **Previous deployments**
   card (the ADR 0018 surface).

2. **The old tree is rebuilt from chain, not Convex (W2).** The web wallet
   normally builds its tree from the Convex leaf mirror (`leavesForChain`,
   keyed by chain → active deployment only), and the cutover **wipes** the
   old deployment's `pampaloLeaves` (ADR 0017, leaf-collision correctness).
   So the withdrawal path instead reads the old contract's
   `LeafInserted(epoch, leafIndex, leafValue)` events from its `fromBlock`
   over RPC and rebuilds the old tree client-side — the technique the
   SDK/CLI sync already proves works with no Convex dependency. The full
   rebuilt tree's root equals the old contract's current root, which is in
   its `isKnownRoot` window, so the proof verifies.

3. **Circuit-compatible bumps only (G1).** A proof is only accepted by the
   *old* contract's `withdrawVerifier` if the client's bundled withdraw
   circuit shares that verifier's vk. The web app bundles **one** circuit
   version, so withdrawal is offered **only** when the old deployment's
   withdraw-circuit vk matches the current bundled circuit (the common case
   — e.g. 1.x → 2.0.0 was Solidity-only). A **circuit-breaking** redeploy
   leaves its notes read-only retired, as before; recovery there is the
   mainnet drain-before-cutover runbook step. The gate needs two new fields
   on `archivedDeployments`: `fromBlock` (for the chain sync) and a
   `circuitVkHash`/tag (for the match).

4. **Retirement wind-down lifts the cap problem at the source.** Notes are
   atomic (`unshield` exits a note's *whole* amount), so a single note worth
   more than the old contract's monthly **unshield** cap could never exit. We
   dissolve this operationally rather than in the UI: at cutover the runbook
   calls, **on the old contract**, `weAreFull()` (halts further deposits into
   the dead contract — it does *not* gate withdrawals) and
   `setDefaultMonthlyCap(<huge>)` (lifts the unshield ceiling; deployer still
   holds `FINANCE_MANAGER_ROLE` there). There is no compliance cost — it is a
   deprecated-contract drain to the user's own public address, not a fresh
   crossover. The only remaining batching is the circuit's **≤3 input notes
   per proof** (>3 notes of an asset ⇒ multiple txs).

5. **Self-broadcast; no relayer plumbing.** A withdrawal deliberately exits
   to the user's own public address, so the relayer's address-unlinking value
   is moot. The existing `private-broadcast` self-broadcast path submits the
   `unshield` against the old contract; the user pays gas. The relayer is not
   extended to target old contracts.

## Considered and rejected

- **Native private migration (new contract surface).** Impossible *out of*
  the already-deployed contract (immutable, no successor-transfer path), and
  for future versions it still leaks the spend-old/create-new correlation;
  the only real win would be cap exemption. Deferred — not worth a permanent
  contract surface for a testnet-era wind-down.
- **W1 — pre-cutover drain only.** Productize the mainnet "drain-first" step
  but offer nothing post-cutover. Cheapest, but doesn't match "withdraw from
  the *previous* version" once the new one is live.
- **W3 — keep old leaves server-side.** Stop wiping / archive `pampaloLeaves`
  so Convex can still serve the old tree. Revisits the 0017/0018
  wipe-for-correctness decision and adds server work; chain-sourcing (W2)
  needs neither.
- **G2 — bundle every historical circuit.** Support withdrawal across
  circuit-breaking bumps by retaining all old proving artifacts. Maximal, but
  pays for a case that hasn't shipped; revisit if a circuit-breaking redeploy
  is ever planned.

## Consequences

- **`archivedDeployments` gains `fromBlock` + `circuitVkHash`** and these must
  be written at cutover (where ADR 0018's archive step already runs), or the
  Withdraw button can't gate or sync. Old rows without them show read-only
  (status quo), so it degrades safely.
- **The retirement runbook gains two old-contract admin calls** (`weAreFull()`
  + `setDefaultMonthlyCap`). `DEPLOYMENT.md` records them.
- **"Read-only history" wording in ADR 0018 / the card is refined** — retired
  notes are withdrawable-but-not-spendable-in-protocol. The ADR 0018 *spend*
  filter is unchanged (retired notes still never enter transfer/unshield
  against the *current* deployment); withdrawal acts against the *old* one.
- **B2 ("Move to new deployment," auto re-shield)** is explicitly out of scope
  here — it is B1 (this) composed with the normal Shield flow, and re-entry is
  still subject to the *new* contract's shield cap + wait + contest window.

## Related

- `docs/adr/0017-non-upgradeable-clean-break-redeploys.md` — immutability +
  the leaf-collision wipe this works around.
- `docs/adr/0018-retired-note-handling.md` — the retire model + Previous
  deployments surface this extends; its "read-only" framing is refined here.
- `CONTEXT.md` — **Retired note**, **Retired-note withdrawal**.
- `DEPLOYMENT.md` — the wind-down calls (item 4) belong in the runbook.
- `sdk/src/sync.ts` — the chain-event tree rebuild reused by W2.

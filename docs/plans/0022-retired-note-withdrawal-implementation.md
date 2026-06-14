# Implementation plan — Retired-note withdrawal (ADR 0022, B1)

Build the **Withdraw to wallet** action on the Previous-deployments card: a
client-side `unshieldBundled` against the *old* contract that exits a retired
note's full amount to the user's own EVM address. No new contract surface;
ADRs 0017/0018 intact. This is **B1** only (no auto-re-shield).

## How the old tree is sourced — DECIDED: `archivedLeaves` snapshot

The cutover wipes `pampaloLeaves` (ADR 0017), and we **can't** leave the old
leaves in place: `seedAll` reuses the one per-chain deployment row, so the new
tree's leaf 0 would collide with the stale old leaf 0 and corrupt the *live*
tree. So at cutover the archive step **snapshots** the old
`(epoch, leafIndex, leafCommitment)` rows into a new **`archivedLeaves`** table
(keyed by old address — collision-safe) *before* the wipe, exactly like
`archivedTransferNotes`/`archivedShieldQueue` already do (ADR 0018). The client
rebuilds the old tree from that snapshot. This supersedes ADR 0018's "leaves
not archived" call, whose premise ("a retired note is never proven") 0022
changes.

- **Cost (accepted):** only deployments retired *after* this ships get a
  snapshot; the already-wiped v1 stays read-only — same "deploy before cutover"
  gate ADR 0018 carries.
- **Rejected — client chain re-scan** (`eth_getLogs` of `LeafInserted`): would
  recover even already-wiped deployments, but `RpcClient` has no log-fetch and
  it's a full-history scan per withdraw. The snapshot reuses the archive step
  and is cached.
- **Rejected (deferred) — multi-row "leave in place"** (retire old row
  `enabled:false`, insert new row): the clean long-term model, but ripples
  through every `by_networkId.unique()` site and rewires the retired-history UI
  off the existing archive tables — more churn than extending the archive.
  Pairs with native migration / B2 later.

## Correctness invariants (must hold or the proof reverts)

- **Frozen old tree before snapshot.** The archived leaf set's root must equal
  the old contract's *current* root (which is in its `isKnownRoot` window). So
  the snapshot must be taken when the old tree is final: **`weAreFull()` called
  *and* the pending-shield queue drained** (no `executeShield` can land a leaf
  after the snapshot). Enforce ordering in the runbook: wind-down + drain
  *before* `seedAll`'s archive step.
- **Full-amount exit, no change.** Withdrawal sets `exitAmount = note.amount`
  so no change output is produced — a change note would land in the dead tree.
- **Gate on circuit match (G1).** Show Withdraw only when the old deployment's
  `transfer_external` vk == the client's bundled circuit vk.

---

## Workstream 1 — Convex schema + seed (the deploy/archive path)

**Files:** `convex/schema.ts`, `convex/shieldQueue/seed.ts`,
`convex/shieldQueue/store.ts`.

1. **`pampaloDeployments`** — add `fromBlock: v.optional(v.number())` and
   `circuitVkHash: v.optional(v.string())` (hex of
   `circuits/transfer_external/target/vk_hash`). Seed both from the
   `SeedDeployment` entry. (`fromBlock` already exists on `SeedDeployment` but
   isn't persisted on the row today; `circuitVkHash` is new on both.)
2. **`SeedDeployment` type + `DEPLOYMENTS` entries** (`seed.ts`) — add
   `circuitVkHash`. `fromBlock` already present.
3. **New table `archivedLeaves`** — `{ chainId, archivedDeploymentAddress,
   epoch, leafIndex, leafCommitment }`, index `by_chain_and_address`. Mirrors
   `archivedTransferNotes`'s shape/keys.
4. **`archivedDeployments`** — add `fromBlock: v.optional(v.number())` +
   `circuitVkHash: v.optional(v.string())`.
5. **`archiveDeploymentChildren`** (`seed.ts`) — before the existing wipe:
   - copy `pampaloLeaves` (by `deploymentId`) → `archivedLeaves` (testnet-scale
     collect-then-insert, same as the other archives);
   - write `fromBlock` + `circuitVkHash` (read from the *existing* old
     deployment row) into the `archivedDeployments` marker insert.
6. **New query `store.listArchivedLeaves`** (`store.ts`) — args `{ chainId,
   pampalo }` → `{ leafIndex, leafCommitment }[]` ascending. Mirror
   `listArchivedDeployments`.
7. **`store.listArchivedDeployments`** — include `fromBlock` + `circuitVkHash`
   in its return so the client can gate + locate.

> `seedAll`'s "archived … then wiped …" log line should now also report the
> leaf count.

## Workstream 2 — Web: rebuild the old tree + the vk gate

**Files:** new `src/lib/use-retired-tree.ts`, new `src/lib/retired-vk.ts`.

1. **`useRetiredTree(chainId, oldPampalo, enabled)`** — mirror
   `use-merkle-tree.ts`, but source rows from
   `api.shieldQueue.store.listArchivedLeaves` instead of `leavesForChain`.
   Returns `{ tree, commitmentToLeafIndex: Map<string, number>, isLoading }`.
   The map recovers `leafIndex` for notes that lack it (fresh-device notes
   rebuilt from `archivedTransferNotes` have no `leafIndex`).
2. **`retiredVkHash()`** — compute/derive the bundled `transfer_external`
   circuit's vk hash once (from `UnshieldBundled`/bb.js, or a build-time
   constant). Used to compare against each archived deployment's
   `circuitVkHash`. Gate helper: `isDeploymentWithdrawable(archived)` =
   `archived.circuitVkHash != null && archived.circuitVkHash === retiredVkHash()`.

## Workstream 3 — Web: the Withdraw action

**Files:** new `src/lib/withdraw-retired.ts`,
`src/lib/private-broadcast.ts` (reuse), `src/lib/idb-notes.ts` (state patch).

1. **`prepareRetiredWithdrawals({ group, notes, tree, commitmentToLeafIndex,
   exitAddress, walletPrivateKey, selfPoseidon, selfEnvelopePubKey })`**:
   - gather that group's retired, value-bearing notes (reuse the card's
     grouping); resolve each `leafIndex` (note's own, else map lookup);
   - **batch ≤3 notes per tx** (circuit `NOTE_COUNT = 3`); for the single-input
     v1 `prepareUnshield`, that's one note per tx unless prep is extended —
     **start with one note per tx** (simplest, matches current `prepareUnshield`
     single-input shape), iterate to 3-input later;
   - for each, call `prepareUnshield` with `pampaloAddress = oldPampalo`,
     `tree = oldTree`, `exitAddress = self`, `exitAmount = note.amount`
     (⇒ no change output).
2. **Sign + broadcast** — `signTransactionWithPasskey` → `rpc.sendRawTransaction`
   (self-broadcast; a withdrawal exits to the user's own address, so the
   relayer's unlinking is moot — no relayer change).
3. **Optimistic state** — on accept, patch each spent note's IDB state to
   `"spent"` with its `spentNullifier` (the card already drops `spent` notes,
   so the row disappears as funds land).

## Workstream 4 — Web: the card UI

**Files:** `src/components/pampalo/RetiredNotesHistory.tsx`.

1. Fetch `listArchivedDeployments` (already does) incl. new fields; compute
   `withdrawable` per group via the vk gate.
2. Per group, add a **Withdraw** button (label "Withdraw to wallet"):
   - **withdrawable:** enabled; on click runs the action, shows per-tx
     progress (and ">3 notes ⇒ N transactions" when batching);
   - **not withdrawable** (vk mismatch / no `circuitVkHash` / pre-archive):
     hidden or disabled with "Read-only — redeployed with a circuit change."
3. Update the card copy: drop the absolute "*can't be spent*"; say retired
   notes can be **withdrawn to your wallet** (and re-shielded via the normal
   flow to go private again).

## Workstream 5 — Tests

**Files:** `contracts/test/*` (already green), new web unit tests.

1. Unit: `prepareRetiredWithdrawals` builds valid calldata against a
   synthetic old tree + note (assert exit slot, zero change, nullifier).
2. Unit: vk gate returns false on a mismatched `circuitVkHash`.
3. (Manual/e2e via `/verify`) full path on a redeployed testnet: retire a
   note, run the wind-down + re-seed (archives leaves), Withdraw, confirm the
   note exits and the card row clears.

---

## What this plan deliberately does NOT do

- **No contract changes.** B1 is pure orchestration; the only on-chain actions
  are the runbook's `weAreFull()` + `setDefaultMonthlyCap` admin calls.
- **No B2 (auto-re-shield).** Re-shielding stays the normal Shield flow.
- **No recovery of already-wiped deployments** (e.g. current v1) — they lack an
  `archivedLeaves` snapshot. Out of scope unless we add the re-scan action.
- **No 3-input batching in v1** — one note per `unshield` tx until
  `prepareUnshield` grows multi-input; large note counts mean multiple txs.

## Sequencing

WS1 (schema/seed) must ship **before** the next cutover (so the archive
captures leaves) — same gate as ADR 0018. WS2–4 can follow independently;
the card simply shows read-only until an archived deployment carries the new
fields. WS1 is also the only part on the critical deploy path.

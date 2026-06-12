# Spent-note reconciliation downloads the public nullifier set; the server never learns which nullifiers a user holds

Sync must mark a note `spent` when it was spent on a different device or
origin (the optimistic spend-write lives only in the IndexedDB that
performed it). On-chain a **nullifier is unlinkable to its leaf**, so only
the note-holder — who has the note's secret — can compute it. The decision:
the indexer records every `Pampalo.NullifierUsed(bytes32)` into a
`pampaloNullifiers` table; the client **downloads the whole public set for a
deployment (paginated) and checks its own notes' nullifiers against it
client-side**, flipping matches to `spent`.

## The explicit "no"

There is deliberately **no `isNullifierUsed(nullifier)` / `nullifiersUsed([…])`
server endpoint.** Asking the server about *specific* nullifiers would tell it
which spent notes belong to this session/address — re-linking a user to their
otherwise-unlinkable notes, which is exactly what the privacy invariant
(`CONTEXT.md`) forbids and what ADR 0004 bounds proxies away from (a proxy may
leak no more than `(chainId, address)`). The first implementation did exactly
this — a batched `eth_call` proxy that sent the user's own nullifiers to the
server — and was replaced for this reason.

Reconciliation only ever fetches the **public set** (identical for every
user); the membership test happens on the client. The server sees "someone
fetched the nullifier set," nothing about which notes are theirs.

## Consequences

- **Any future "efficiency" change that adds a per-nullifier server lookup
  reintroduces the leak and must be rejected.** This is the load-bearing
  invariant, not the table.
- The client downloads a set that grows with *total protocol spends*, vs
  `O(my notes)` RPC calls. Accepted: the privacy property is non-negotiable,
  the query is paginated, and an incremental client-side cache (persist the
  set in IndexedDB, pull only new pages keyed by block) is the documented
  optimization for when the set gets large.
- Historical nullifiers (emitted before the indexer started recording them)
  are populated by `shieldQueue/refresh:backfillNullifiers`, a one-off scan
  that leaves the live indexer cursor untouched.

## Related

- ADR 0004 — thin RPC proxies; the `(chainId, address)` leak ceiling this
  extends to the sync/read path.
- `CONTEXT.md` — the privacy invariant (server cannot link a user's notes to
  their address).

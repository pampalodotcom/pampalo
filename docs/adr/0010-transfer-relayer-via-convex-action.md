# Transfer relayer lives in a Convex action, not a separate service

Pampalo's transfer flow needs a broadcaster other than the user's EOA
so that paying gas does not link the user's address to the on-chain
transfer event. The transfer contract is permissionless — anyone with
a valid proof can submit — so the broadcaster doesn't need any role,
just funded accounts and the ability to send `eth_sendRawTransaction`.

The decision: the relayer is a Convex action (`transfers.relay`)
backed by a single `RELAYER_MNEMONIC` env var, deriving the first 5
BIP44 Ethereum accounts as a per-chain pool. See `TRANSFERS.md` for
the full design.

## What we picked over

- **(B) Standalone HTTP service** (Cloudflare Worker, Node service).
  Would keep the relayer out of Convex's request path, isolate the
  mnemonic to a different runtime, and let the broadcaster be reached
  by clients that aren't on Convex. Rejected for v1: it introduces a
  second deploy target, a second secrets surface, and a second
  observability stack. The privacy floor (Convex transport logs
  cluster by session token) is the same in both — Convex is already
  in the picture for every other authenticated call the client makes.
- **(C) Convex queue with background broadcaster.** Client posts a
  request, gets an ID, polls for completion. Decouples the broadcast
  latency from the user-facing call. Rejected for v1: there is
  nothing in transfer broadcasting that benefits from queueing.
  `eth_sendRawTransaction` returns in <500ms typically; the existing
  shield path is already shaped this way and works fine.

## Consequences

**Operational surface stays small.** One mnemonic env var. One table
of 5 rows per sponsoring chain. One cron for reconciliation, one cron
for zombie-lock reaping. The seed function does the per-chain
initialization atomically with the existing `pampaloDeployments` seed.

**Privacy posture is honest about transport-level linkage.** Convex's
own request audit log records the session token on every relay call.
We do not write a domain table that joins session → tx, but the
existence of the call is logged with a stable session identifier. See
`AUTH.md §1` for the residual cluster-by-token property we explicitly
accept. Moving to a standalone service would shift this surface to a
different log stream but does not eliminate it.

**Throughput is bounded by the 5-account pool per chain.** A
mutation-based mutex guarantees no two concurrent transfers collide on
the same account. At lock time (~300ms) the pool sustains ~16
transfers/sec/chain, which is luxurious for the expected scale and
trivially extensible by growing the pool size.

**Graceful degradation when sponsoring is unavailable.** The action
returns `POOL_BUSY` / `POOL_EXHAUSTED` / `CHAIN_NOT_SPONSORED` and
the client falls back to self-broadcast (the existing
`signTransactionWithPasskey` path). The fallback is privacy-degrading
but keeps transfers functional. The UX surfaces this via an explicit
confirm dialog so the user is not silently un-private.

**Schema and contract are minimally affected.** No new on-chain
contract; `Pampalo.transfer` is already permissionless. Convex schema
adds two fields to `pampaloDeployments` (`sponsoringTxs`,
`minRelayerBalanceWei`) and one new table (`relayerAccounts`). No
`shieldQueueEntries` change.

## What this decision blocks if we change it later

- Moving to a separate HTTP service means re-deploying the secret,
  carving out the new runtime's observability, and adding a new IP-
  layer abuse-protection scheme. Manageable but not free.
- Switching to a queue model means adding a `relayQueue` table, a
  background broadcaster, and a client-side "still working" UI state.
  Worth doing if we ever batch broadcasts or want server-side retry
  logic, but adds three new failure modes.
- Storing per-user broadcast logs would close the cluster-by-token
  threat model gap, but requires `AUTH.md` to flip from "we accept
  this residual linkage" to "we eliminate it," which is a stronger
  privacy claim. Out of scope for v1.

## Related

- `TRANSFERS.md` — the full design plan this ADR records.
- `AUTH.md §1` — residual linkage threat model.
- `docs/adr/0004-send-flow-thin-rpc-proxies.md` — the precedent for
  thin Convex-action RPC proxies; this ADR extends the same shape.
- `docs/adr/0008-shield-to-self-only-in-v1.md` — upstream of cross-
  recipient transfers; future iteration.

# COMPLIANCE_TRACK.md

How we track on-chain sanctions data for the pool's compliance gate.

This document covers the **Chainalysis Sanctions Oracle** — the on-chain
contract that publishes OFAC/EU/UN sanctioned addresses. It is the canonical
"bad actor" source the protocol screens against (the same public list
RAILGUN's default Private Proof of Innocence list ultimately tracks).

> **Privacy note (see `CLAUDE.md`).** The sanctions list is **public-by-intent
> data**: sanctioned EVM addresses published openly on-chain. Indexing and
> storing it needs **no encryption** — it is not user data. The privacy
> boundary is on the *user* side: any computation that links one of *our*
> users to this list must happen client-side (or be encrypted), never stored
> as a plaintext user→sanction mapping on the server.

---

## 1. The contract

**Chainalysis Sanctions Oracle** (a.k.a. `SanctionsList`).

- Read function: `isSanctioned(address) → bool`
- Verbose read: `isSanctionedVerbose(address) → bool` (emits per-call query
  events — **not** state, see §3)
- Owner-only mutators (Chainalysis only): `addToSanctionsList(address[])`,
  `removeFromSanctionsList(address[])`
- Metadata: `name() → string` ("Chainalysis sanctions oracle"), `owner()`

The oracle is permissionless to read and requires no relationship with
Chainalysis. It lags real-world OFAC designations by hours-to-days — treat it
as "Chainalysis's view," not ground-truth-at-this-instant.

---

## 2. Networks & addresses

Chainalysis deploys the oracle at the **same address on every supported EVM
chain** via deterministic deployment:

```
0x40C57923924B5c5c5455c48D93317139ADDaC8fb
```

| Network            | Chain ID | Oracle address                               | Indexing start block |
| ------------------ | -------- | -------------------------------------------- | -------------------- |
| Ethereum mainnet   | 1        | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | `14356508` ✅        |
| Polygon PoS        | 137      | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | verify on explorer*  |
| BNB Smart Chain    | 56       | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | verify on explorer*  |
| Avalanche C-Chain  | 43114    | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | verify on explorer*  |
| Arbitrum One       | 42161    | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | verify on explorer*  |
| Optimism           | 10       | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | verify on explorer*  |
| Fantom             | 250      | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` | verify on explorer*  |

\* Only the Ethereum start block (`14356508`) is confirmed. For every other
chain, **do not index from block 0** (you'll waste days of `getLogs` calls on
empty ranges). Get the real deploy block from the contract's first transaction
on the chain's explorer before configuring the indexer:

```
# example: earliest activity on the address
https://arbiscan.io/address/0x40C57923924B5c5c5455c48D93317139ADDaC8fb
https://polygonscan.com/address/0x40C57923924B5c5c5455c48D93317139ADDaC8fb
# ...etc. Record each in the table above once verified.
```

> Base and other newer L2s are **not** confirmed deployed at the time of
> writing — verify the address has bytecode (`eth_getCode != 0x`) on the target
> chain before trusting it. A missing oracle that silently returns no logs is a
> fail-open hole.

---

## 3. Events to index

Replaying these two events from the start block reconstructs the **entire
current sanctioned set** — add on one, remove on the other.

| Event                       | Signature                              | `topic0`                                                             |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `SanctionedAddressesAdded`  | `SanctionedAddressesAdded(address[])`  | `0x2596d7dd6966c5673f9c06ddb0564c4f0e6d8d206ea075b83ad9ddd71a4fb927` |
| `SanctionedAddressesRemoved`| `SanctionedAddressesRemoved(address[])`| `0x32aab684eee99db715515d1a9987a8fe33bb6341b0e35e60db7eab48a08f9a3a` |

```solidity
event SanctionedAddressesAdded(address[] addrs);
event SanctionedAddressesRemoved(address[] addrs);
```

**The argument is an `address[]` array** — a single log can add/remove many
addresses at once. The array is ABI-encoded in `data` (not indexed/topics), so
you must decode the data field; flatten the array into one row per address when
you persist.

### Do NOT index these for state

```solidity
event SanctionedAddress(address addr);     // topic0 0x8027911123971054d93579ebea046c8461473fa4d2e510b9b49eed3bed3270e0
event NonSanctionedAddress(address addr);  // topic0 0xd595018321fcb8c2bcbf5bfe4b27d74bea505825f7d195abe8517f94a065539c
```

These are emitted by `isSanctionedVerbose()` *query* calls — they reflect who
*asked*, not changes to the list. Indexing them will corrupt your set. Ignore.

---

## 4. Historical backlog indexing

Goal: build the full current set, then stay live.

1. **Configure per chain:** `{ chainId, address, startBlock }` from §2. Always
   start at the verified deploy block.
2. **Page `eth_getLogs`** over `[startBlock, head]` in fixed windows
   (e.g. 2k–10k blocks; many public RPCs cap range or result count). Filter:
   - `address = 0x40C5...8fb`
   - `topics[0] in { ADDED_TOPIC, REMOVED_TOPIC }`
   On a range/limit error, halve the window and retry (binary backoff).
3. **Decode `data`** as `address[]`. For each address:
   - `Added`  → upsert row, `active = true`,  record `addedBlock`/`addedTx`.
   - `Removed`→ set `active = false`, record `removedBlock`/`removedTx`.
   Process logs **in order** (`blockNumber` then `logIndex`) so a same-block
   add-then-remove resolves correctly.
4. **Persist a cursor** `{ chainId, lastIndexedBlock }` after each window so a
   crash resumes instead of restarting.
5. **Go live:** subscribe to new logs (or poll head on an interval) for the
   same filter and apply the same upsert logic. Advance the cursor.
6. **Re-org safety:** treat the last N blocks (chain-dependent; ~12 for
   Ethereum, more for some L2s) as soft until confirmed; re-scan that tail each
   poll rather than trusting the first sighting.

### Reconciliation / drift check

The event replay is the source of truth, but verify against the live view
function periodically:

- For a sample of `active = true` rows, call `isSanctioned(addr)` — must be
  `true`.
- For recently removed rows, `isSanctioned(addr)` must be `false`.
Any mismatch means a missed log or a re-org you didn't unwind — alert and
re-scan from the last known-good cursor.

Cross-check tooling: the public [Dune query](https://dune.com/queries/607033)
("Chainalysis: Sanctions Oracle - Sanctioned Addresses") is handy for spot-
checking your set size against an independent indexer.

---

## 5. Suggested storage shape (Convex)

Public tables — **no encryption** (see top note):

```ts
// sanctionedAddresses: one row per (chain, address)
{ chainId: number, address: string /* lowercased */, active: boolean,
  addedBlock: number, addedTx: string,
  removedBlock?: number, removedTx?: string,
  updatedAt: number }
// index by ["chainId", "address"] for O(1) screening lookups

// indexerCursor: one row per chain
{ chainId: number, lastIndexedBlock: number, updatedAt: number }
```

Screening lookup at deposit/withdraw time is then a single indexed read:
`isSanctioned(chainId, addr) = exists row && active`. Keep the *result's*
linkage to a specific app user client-side only.

---

## Sources

- [Chainalysis oracle docs](https://go.chainalysis.com/chainalysis-oracle-docs.html)
- [Oracle on Etherscan (`0x40C5…8fb`)](https://etherscan.io/address/0x40c57923924b5c5c5455c48d93317139addac8fb)
- [0xsequence/chainalysis (reference indexer + address list)](https://github.com/0xsequence/chainalysis)
- [Dune: Chainalysis Sanctions Oracle addresses](https://dune.com/queries/607033)
- [ChainArgos: on oracle update latency](https://medium.com/chainargos/the-chainalysis-sanctions-oracle-when-should-you-be-concerned-its-late-d386e40971b2)

*topic0 hashes in this doc were computed with keccak-256 over the canonical
event signatures and verified against the known empty-string digest.*

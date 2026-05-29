# Shield to self only in v1

The Pampalo contract's `shield` / `shieldNative` accept an arbitrary
recipient — the note's `owner` field is whatever Poseidon identifier
the proof commits to, which may belong to anyone the depositor has
the envelope key for. The v1 client (slider + confirm sheet + IDB
schema + Convex rescan path) deliberately restricts to **self-shield**:
the recipient's Poseidon identifier is always the depositor's own,
and the encrypted payload is always ECIES-to-self.

## Consequences

The decision keeps every client-side surface trivial:

- The slider has no recipient picker. The "PRIVATE" side of the
  split bar is always the user's own private balance.
- The ECIES payload is always encrypted to the user's own envelope
  key. The plaintext four-tuple `(secret, asset, amount, owner)` is
  computed and sealed inside the confirm-sheet code path; no
  envelope-key discovery or address-book UI is required.
- The fresh-device / IDB-wiped rescan path is a single Convex query:
  `shieldQueueEntries WHERE shielder == self.evm.lowercased`. Every
  row in that result belongs to the user by construction; no
  trial-decrypt loop is needed.
- The IDB `notes` row carries `owner == self.poseidon` on hydrate,
  and a `poseidon2([asset, amount, owner, secret]) === leafCommitment`
  sanity check catches any indexer corruption that would otherwise
  let an attacker plant someone else's note in our cache.

Reversing this decision later (adding shield-to-others) is
non-trivial and worth recording up-front:

- The slider grows a recipient picker, which raises the question of
  where envelope keys for other users are discovered. There's no
  on-chain registry today.
- The rescan path becomes trial-decrypt: every `ShieldQueued` row on
  any active **Pampalo deployment** is a candidate for "you received
  this note," and the client has to attempt envelope-key decrypt on
  each. On Base Sepolia v1 traffic this is trivial; at mainnet scale
  it becomes a background scan job and a sync-cursor design problem.
- A new `transferIns`-style IDB store is needed for inbound shields
  that didn't originate from the user, because the existing
  `shieldQueueEntries` table indexes on the shielder as the user.
- The note four-tuple plaintext format **already supports this**.
  v1 puts `owner` inside the encrypted payload from day one (rather
  than letting the recipient infer it as "myself"), so adding
  shield-to-others doesn't require a payload-format version bump.
  This is the one thing v1 pays forward.

The alternative considered was building shield-to-others from the
start, on the argument that "you can't pull this feature out later."
Rejected because the v1 shipping target is the single-user, single-
testnet flow — the marginal user value of supporting third-party
recipients does not justify ~2× UI surface and a non-trivial
trial-decrypt scanner before the self-shield path even runs end to
end.

The trade-off is locked, not permanent. When (if) shield-to-others
lands, it will revisit this ADR.

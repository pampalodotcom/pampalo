# Shield cap charged at queue, refunded on cancel and contest

The $100/month per-address shield cap is charged against
`shieldUsage[shielder]` at the moment a shield is **queued** (inside
`shield` / `shieldNative`, before `ShieldQueued` is emitted). The exact
USD-cents amount charged is recorded on the `PendingShield` struct as
`usdCentsCharged`. On `cancelShield` (shielder's own opt-out) and
`contestShield` (`VIGILANT_CITIZEN_ROLE`'s compliance veto), that same
amount is subtracted back from `shieldUsage[shielder].usdCentsUsed`,
clamped at zero. A pending shield that is never executed and never
cancelled — i.e. abandoned — leaves the cap consumed; this is the only
way the cap can be "spent without a note arriving."

The shielder's `msg.sender` is also `_chargeShield`'s charged account,
not the recipient's Poseidon identifier — the recipient is private and
unknowable on-chain at shield time. The cap is therefore an
"anti-self-shielding" budget, not an "anti-receive" budget.

## Consequences

The naive design — charge at queue, never refund — was rejected. The
anti-grief argument for non-refund is weak because each cycle costs gas
+ proof-generation CPU and is rate-limited by the 1-hour wait; the
user-fairness argument *against* non-refund is strong because a
vigilant-citizen contest is a compliance action that will sometimes
fire on false positives, and burning the user's entire monthly cap on
a false positive is hostile. Charge-and-refund is the cleanest
encoding of "the cap measures notes that arrived in the tree," with a
small grace for "and notes whose owner abandoned them between queue and
execute."

The `PendingShield` struct gains a `uint64 usdCentsCharged` field. Both
`cancelShield` and `contestShield` read it and decrement the usage map
before deleting the pending entry. Refunds use the queue-time price
(not the cancel-time price) so the cap math is consistent with what
was charged — Chainlink price drift between queue and cancel does not
alter the refund.

Charge-at-execute was also rejected: it would let a shielder fill the
queue with $1000 of pending shields and discover only at execute time
that the cap allows at most $100 through. The queue-time check fails
fast.

The unshield path does not have an analogous refund because there is
no unshield queue — `unshield` and `unshieldBundled` charge
`unshieldUsage[msg.sender]` in-call and there is nothing to undo.

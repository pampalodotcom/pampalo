# No SHIELD_ROLE; the contest mechanism replaces it

`Pampalo.shield` and `Pampalo.shieldNative` are **not** role-gated. Any
EOA can call them, subject to the per-shield checks (supported asset,
monthly cap, kill switch, queue wait). Upstream `commbank.eth` gates
its `deposit` / `depositNative` behind `DEPOSIT_ROLE`; Pampalo drops
that role and uses the `VIGILANT_CITIZEN_ROLE` → `contestShield`
mechanism as the explicit replacement for compliance gating.

## Consequences

`Pampalo.sol` reads as if it's "permissionless shielding," and at the
contract level it is. The compliance posture lives entirely in the
queue: every shield enters a 1-hour wait during which a
`VIGILANT_CITIZEN_ROLE` holder can `contestShield(id, reason)` to
refund the shielder and prevent the leaf insertion. The role is
intentionally per-shield veto power, not per-address whitelist
gatekeeping.

A future engineer reading the contract may reasonably expect a
`SHIELD_ROLE` gate (it's how the upstream and most similar protocols
work). Several arguments compounded into the decision to omit it:

1. `contracts/README.md`'s compliance story — *wait + monthly cap +
   supported-asset whitelist + vigilant-citizen contest + kill switch*
   — already covers every legitimate gating concern. A whitelist on
   top doesn't add a meaningful axis.
2. A whitelist doesn't actually solve Sybil-cap-evasion (an attacker
   willing to spin up fresh EVM addresses to dodge the $100 cap is
   equally willing to request whitelist membership from those
   addresses), so adding it would be ceremonial.
3. It conflicts with the product positioning: "open, compliance-friendly
   private money" is not the same product as "permissioned private
   money."
4. It complicates the ETHGlobal booth flow — granting `SHIELD_ROLE` to
   every booth visitor's EVM address before they can shield is worse
   UX than a queue with `BOOTH_OPERATOR_ROLE` per-shield bypass.

`weAreFull()` remains the emergency "stop all new shields" lever; that
covers the operational concern of "we need to stop shielding *right
now*" without a per-address whitelist.

If a future Pampalo deployment ever does need a whitelist (e.g. a
regulated jurisdiction variant), it's added as a new contract — not
retrofitted into this one. The decision to ship unpermissioned is a
deliberate identity choice.

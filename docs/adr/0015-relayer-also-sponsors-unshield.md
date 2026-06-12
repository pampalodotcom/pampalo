# Relayer sponsors unshield as well as transfer

Supersedes the transfer-only scope of ADR 0010. The Convex relayer
(`RELAYER_MNEMONIC`, 5-account per-chain pool, atomic acquire/release —
all unchanged) now broadcasts `Pampalo.unshield(...)` in addition to
`Pampalo.transfer(...)`.

## Why

`unshield` already publishes its recipient EVM address on-chain (it's a
public input to the `transfer_external` circuit), so at first glance
sponsoring it "leaks nothing the chain doesn't already show." That misses
the actual win: **gas**. Without sponsorship the recipient address must
already hold ETH to pay for the withdrawal, which links a funded EOA to
the unshield event. With sponsorship the holder can unshield to a
**brand-new, unfunded address** and the relayer pays gas — the recipient
never has to touch a linkable, pre-funded account. That is the same
EOA-anonymity property the relayer already provides for transfers,
extended to the exit.

`unshield` is permissionless on-chain (like `transfer`), so the relayer
still holds **no on-chain role**; the only new thing it spends is gas.

## What we picked over

- **Transfer-only (status quo, ADR 0010).** Smaller surface, no new
  abuse vector, but withdrawals stay linkable to a funded address —
  re-funding a "clean" exit address is itself a linkage. Rejected: it
  leaves the most sensitive moment (cashing out) the least private.
- **Sponsor unshield only to a pre-registered self-address.** Caps who
  we'll pay gas for, but couples the relayer to a per-user address
  registry (a new linkable table) and forbids the legitimate
  "withdraw to a fresh address" case that motivates the feature.
  Rejected as both weaker on privacy and heavier to build.

## Consequences

**New gas-drain surface, so every relay is gated.** Because the relayer
now pays gas to move value *out* to arbitrary addresses, an attacker who
can get a free broadcast can burn the sponsor's ETH. Three gates, cheap
to expensive:

1. **Non-zero proof.** Reject empty or all-zero `_proof` / public-input
   bytes before doing any RPC work — a trivially-malformed request never
   reaches simulation.
2. **`eth_call` simulation.** The candidate raw tx is simulated against
   the deployment; any revert (bad proof, spent nullifier, unknown root,
   over-cap) returns `WOULD_REVERT` and is never broadcast. The relayer
   spends gas only on transactions that will succeed.
3. **Monthly cap.** The on-chain `_chargeUnshield` enforces the
   per-address USD ceiling; a request that would exceed it reverts in
   simulation and is refused.

**No new contract.** `Pampalo.unshield` is already permissionless and
already cap-charged. This ADR is a relayer-scope change only.

**Same fallback shape.** `CHAIN_NOT_SPONSORED` / `POOL_BUSY` /
`POOL_EXHAUSTED` and the explicit self-broadcast confirm dialog from
ADR 0010 apply unchanged to unshield.

## What this blocks if we change it later

Pulling unshield back out of the relayer would re-link every fresh-address
withdrawal to a funded EOA. Reversible in code, but it is a public
privacy regression once shipped.

## Related

- `docs/adr/0010-transfer-relayer-via-convex-action.md` — superseded
  transfer-only scope; the Convex-action architecture it records still
  stands.
- `TRANSFERS.md` — relayer design plan (to be extended for unshield).
- `CONTEXT.md` — **Gas sponsor / Relayer account**, **Unshield**.

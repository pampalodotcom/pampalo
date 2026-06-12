# Private payments settle via a standalone membership singleton, two-step and non-atomic

Pampalo lets a contract accept a **private payment** the way it accepts
an ERC-20. The decision: a buyer pays a merchant out-of-band via an
ordinary `transfer` (creating a note owned by the merchant's Poseidon
identifier), and later proves that payment landed using a new `redeem`
membership circuit. A standalone, permissionless `PampaloPayments`
singleton verifies the proof, burns a domain-separated **redeem
nullifier**, and binds every public input to the consuming contract's
expectations — on behalf of any contract that inherits
`PrivatePaymentAcceptor`. The singleton only *reads* roots from the live
Pampalo deployment (`isKnownRoot`); it never moves value and never
writes to the audited core.

## What we picked over

- **(B) Atomic `transferAndPay`** — collapse pay + deliver into one tx by
  carrying a `transfer` proof into the purchase, inserting the merchant's
  output leaf, and delivering the good in the same call. Removes the
  settlement race entirely and needs no waiting. Rejected for v1 because
  it is **not standalone**: inserting leaves requires privileged access
  to Pampalo's `_insert`, so it would either add a method to the audited
  core or grant a leaf-inserter role. We deliberately keep this as a
  documented future seam — the vendor-facing `_acceptPayment` signature
  is shaped so an atomic backend can slot in later without changing it.
- **(C) Per-acceptor nullifier registry** — each storefront keeps its own
  `redeemNullifierUsed` map and binds the consumer in-circuit to stop
  cross-shop replay. Rejected: a note could then be reused once *per
  consumer*, and every vendor re-implements the burn. The shared
  singleton makes a payment single-use **globally, once, ever**.
- **(D) NFT-specific redeemer** — the original framing escrowed a
  `tokenId` and released it on redeem. Rejected in favour of a generic
  payment interface: vendors accept private payment like an ERC-20 and
  decide for themselves what to deliver (`MockShop` is the reference
  integration).

## Consequences

**The split verify-then-deliver needs an explicit anti-grief binding.**
Because the singleton's `verifyAndBurn` is permissionless and separate
from delivery, a mempool watcher could copy `(proof, publicInputs)` and
burn the nullifier without delivering, stranding the payer's note
forever — a DoS the atomic Pampalo paths cannot suffer. We close it by
binding the `consumer` contract as a public input and requiring
`msg.sender == consumer` in the singleton. The proof's eight public
inputs (`root, redeem_nullifier, merchant_id, asset_id, asset_amount,
recipient, consumer, reference`) are therefore **bytecode-bound**:
changing the layout means a new circuit, a new `RedeemVerifier`, and a
coordinated contract update.

**Settlement is non-atomic, so 1-of-1 inventory carries a race.** Two
buyers can pay for the same scarce good before either redeems; only one
settles, the other is left to an off-protocol refund. Acceptable for
made-to-order / open-edition storefronts; true 1-of-1s should wait for
the atomic path (B) or an on-chain reservation.

**The vendor owns a kill switch.** `PrivatePaymentAcceptor` exposes
`privateEnabled`, toggled by the `privatePaymentAdmin`. While off, the
private branch reverts and the public ERC-20 branch still works — any
vendor accepting private payment can disable it unilaterally.

**Merchant identity is self-declared config, not verified on-chain.** A
merchant's envelope key cannot be checked in the proof (it never enters
the circuit — it only matters on the payment leg so the merchant can
decrypt and later spend the note). `merchantId` is the acceptor's own
config; declaring an id you don't control only makes payments to you
unspendable by you.

# Private swaps mint fixed-output notes; no on-chain note construction

A **Private swap** (note A → note B against public Uniswap v4 liquidity)
faces an irreducible problem: the realized AMM output amount does not exist
at proof-generation time, so it cannot be committed inside the ZK proof.
Minting a note at the *realized* amount would require the contract to
compute the arity-4 note commitment `poseidon2([asset, amount, owner,
secret])` on-chain — but Pampalo's only on-chain hasher is the arity-2
tree-node compressor (`hashLeftRight`). On-chain construction would mean
deploying a **second, arity-4 Poseidon2 hasher byte-exactly matched to
Noir** — new infra and the integration's single biggest audit risk.

**Decision:** the swap is **exact-input** and mints a **fixed-output note**
at a target amount `T`, committed in-circuit (so the commitment stays a
public input, exactly as every other flow). The contract enforces
`require(realized >= T)` — `T` doubles as the slippage/sandwich floor,
there is no separate `minOut` — and the **surplus `realized − T` is
forfeited** into the contract's pooled asset-B reserves, unowned by any
note. No on-chain Poseidon, no new hasher. **No monthly cap is charged**:
value stays inside the shield and extraction remains gated at unshield.

## Consequences

The user forfeits not only the slippage buffer but *all* favourable price
movement above `T` — downside is revert-protected, upside is donated. `T`
is picked at proof time before the relayer sees the live price, so a
slippage buffer is unavoidable; tightening it trades forfeit for revert
frequency. Forfeited surplus raises reserves over note liabilities
(solvency-positive) and is left in the pool rather than swept.

## Rejected alternatives

- **On-chain arity-4 Poseidon (capital-exact, zero forfeit).** Rejected on
  implementation cost: a byte-exact match to Noir's sponge is the
  highest-risk part of the integration. This reverses the reasoning in the
  v4 spec appendix, which rejected forfeit on *privacy* grounds — correct
  on privacy, but it ignored infra cost, which is what dominates here.
- **Deferred claim slot.** Record `(asset, realized, owner)` publicly and
  let the user mint later with a normal proof. Avoids on-chain hashing but
  reintroduces a linkable second transaction and a public escrow record —
  exactly what the nullifier exists to cut.
- **Exact-output.** The output note is clean, but the input *change* note
  then has a runtime amount and needs on-chain construction anyway.
  Dominated.

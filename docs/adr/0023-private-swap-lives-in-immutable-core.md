# Private swap lives in the immutable core, not a satellite module

A **Private swap** must mutate core state: it nullifies the input note and
`_insert`s the output (asset-B) and change (asset-A) commitments into the
Pampalo merkle tree. This is unlike the **Payments singleton**
(`PampaloPayments`), which only *reads* core roots via `isKnownRoot` and
writes nothing to the core. A swap is a writer, so the "standalone contract
that reads roots" pattern is not available to it.

It also carries the **Uniswap v4 integration** (`privateSwap` →
`poolManager.unlock` → `unlockCallback`), which ADR 0020 names the
integration's single biggest audit risk. That risk sits inside a contract
(`Pampalo.sol`) that is **non-upgradeable** by ADR 0017 — so the question is
where the v4-touching code is allowed to live.

## The decision

`privateSwap` and its `unlockCallback` are **methods on the immutable core
`Pampalo.sol`**, verified by a dedicated `swapVerifier`, mirroring how
`transfer` / `unshieldBundled` already nullify-and-insert. The core remains
the **sole writer of its own tree and nullifier set**. A bug in the v4
integration is fixed the same way any core bug is: a clean-break redeploy
(ADR 0017), with the old deployment's notes retiring gracefully (ADR 0018)
and exitable via retired-note withdrawal (ADR 0022).

The baked-in risk is kept small by scope: v1 is **single-hop WETH↔USDC
only** (ADR-0020-era decision), so `unlockCallback` executes exactly one
swap against one known PoolKey — there is no untrusted multi-hop path
executor in the core yet.

## Why not a satellite module with a core write-role

The alternative was a separate, independently-redeployable `PampaloSwap`
holding the v4 logic, granted a `SWAP_MODULE_ROLE` on the core so it could
call privileged `insert` / `nullify` entrypoints. This would let a v4 bug be
patched by redeploying only the satellite, without retiring any notes.

Rejected because it introduces a **privileged external writer to the core's
tree and nullifier mapping** — the exact invariant the core exists to
protect. A buggy or compromised swap module with that role could insert
unbacked notes or burn nullifiers arbitrarily, a strictly larger and
harder-to-reason-about trust surface than keeping all tree writes inside one
audited contract. ADR 0017 already treats redeploys as expected and
low-drama (notes retire, they don't vanish), so the satellite's main
benefit — avoiding a redeploy — buys less here than it would in an
upgradeable-contract world, while its cost (a standing privileged writer) is
permanent.

## Consequences

- The v4 integration's blast radius is the whole core: a v4 bug discovered
  post-deploy means a clean-break redeploy, not a hot-swap of one module.
  Acceptable because single-hop-WETH↔USDC keeps the surface minimal and
  ADR 0017 makes redeploys survivable.
- When multi-hop (the untrusted-path executor) is added later, it inherits
  this decision — the highest-risk code lands in the immutable core. That is
  the moment to revisit whether the executor specifically warrants
  isolation, even if `privateSwap` itself does not.
- No new role is added to the core for swaps; the relayer that broadcasts a
  swap holds no on-chain role, exactly as for transfer/unshield.

## Related

- ADR 0017 — non-upgradeable, clean-break redeploys.
- ADR 0020 — fixed-output notes; v4 as the biggest audit risk.
- ADR 0014/0022 — retired-note handling and withdrawal (the graceful-exit
  path a redeploy relies on).

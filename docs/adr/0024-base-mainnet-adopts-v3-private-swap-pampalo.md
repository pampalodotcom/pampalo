# Base mainnet adopts the v3 private-swap Pampalo (3.0.0), deployed fresh

Base mainnet (8453) upgrades from the non-swap Pampalo (`0x86cC…`, on-chain
`VERSION 2.0.0`) to a **swap-enabled superset** — `PampaloSwapV3`, `VERSION
3.0.0`. Private swaps require real Uniswap liquidity, which only exists on
mainnet, so this is where the swap feature goes live. Because
`PampaloSwapBase is Pampalo` (a superset, ADR 0023), this is a clean-break
redeploy (ADR 0017) over an *active, real-money* deployment, with retired-note
withdrawal (ADR 0022) as the recovery path.

## The decision

1. **v3 venue, not v4.** Bind the app to the **v3 venue**
   (`SwapRouter02.exactInputSingle`, the 0.05% WETH/USDC pool) — deepest Base
   liquidity and the *lower* audit surface (ADR 0020/0023 name v4's
   `unlock`/`unlockCallback`, now in the immutable core, as the biggest risk).
   The **v4** subclass stays available but **parked** until Base v4 liquidity
   matures. See **Swap venue** in `CONTEXT.md`: one venue per deployment, so this
   choice fixes both the wallet's tree and the sole liquidity source.

2. **Deploy fresh as `VERSION 3.0.0` — do not reuse the agent's contract.**
   `VERSION` is a bytecode constant whose purpose is on-chain auditability
   (`pampalo.VERSION()`, surfaced on `/sentry`). The agent's earlier mainnet
   deploys (`0x940b…` v3, `0x6655…` v4 in `8453-swap.json`) were compiled while
   the source said `2.0.0`, so they report `2.0.0` on-chain *permanently* and
   were deployed from a throwaway key (`AGENT_MNEMONIC` idx 1). To make
   `/sentry` tell the truth we **bump the source to `3.0.0` and redeploy
   `PampaloSwapV3` fresh**. The agent's `0x940b`/`0x6655` are kept as
   **validation artifacts** (they proved the contracts work with a live swap),
   not the live deployment.

3. **Deploy from the standard ops deployer → no key rotation.** Because we're
   redeploying, deploy `PampaloSwapV3` from the **standard deployer** (`0x77c2…`,
   the v2 deployer) so the constructor grants `DEFAULT_ADMIN` + all roles to the
   right key from the start. Then the *normal* per-deploy role grants apply
   (`grant-roles.ts`): ops roles → `0x3017…`, `VIGILANT_CITIZEN` → the compliance
   signer (RELAYER_MNEMONIC idx 5). No renounce dance, no ad-hoc key in the trust
   path. This is strictly simpler than the reuse-and-rotate path it replaces.

4. **Reverify after deploy.** Re-run the contract test suite (`pnpm --filter
   @pampalo/contracts test`, incl. the private-swap + forked-liquidity suites)
   and verify the deployed sources on Basescan (Pampalo/PampaloSwapV3 + the four
   standard verifiers + `SwapVerifier` + the Poseidon2 hasher).

5. **The cutover is a real-money clean-break; eject is the recovery path.**
   `0x86cC…` holds real funds (the operator's own). Repointing the 8453 row
   `0x86cC → <new v3 address>` retires those notes; in-app recovery is
   retired-note **eject** (ADR 0022), already built. Because the funds are
   self-only and `0x86cC` stays callable on-chain forever, **eject UI
   verification may trail the cutover** — but the **`archivedLeaves` snapshot is
   one-shot**: `seedAll`'s wipe is irreversible, so WS1 (snapshot + vk-stamp)
   must be live on **prod** Convex and the **two-phase seed** (stamp `0x86cC`
   row → then repoint) must run *at* cutover, or in-app eject for `0x86cC`
   becomes impossible (only manual chain recovery remains).

## Considered and rejected

- **Reuse the agent-deployed `0x940b`** (the prior plan). Rejected once a true
  on-chain `3.0.0` was wanted: `0x940b` is frozen at `2.0.0` (can't be changed —
  immutable bytecode), and it carries a throwaway-key admin that would need a
  rotate-and-renounce dance. A fresh deploy gives honest auditability *and*
  correct roles from the constructor; the deploy script is already validated, so
  the only real cost is gas.
- **v4 venue now.** Thinner Base liquidity and the highest-risk integration in
  the immutable core. Parked; switching later is a redeploy + ADR-0022 migration.
- **Support both venues.** Impossible under one-venue-per-deployment: a note
  lives in one contract's tree and can only swap against that venue.

## Consequences

- **`VERSION` is now `3.0.0`** in `Pampalo.sol`, inherited by the venue
  subclasses; any fresh deploy bakes it in. Bumping the source does **not** alter
  already-deployed bytecode — only the fresh deploy reports `3.0.0`.
- **The v3 venue wraps ETH↔WETH internally — WETH is *not* a user-facing
  asset.** `PampaloSwapV3._executeSwap` deposits input ETH to WETH for the
  router and unwraps a WETH output back to native ETH (needs a `receive()` +
  a `WETH` immutable, Base `0x4200…0006`). So native-ETH notes swap directly
  and the asset set stays ETH/USDC — **reversing the earlier "WETH joins the
  shieldable-asset set" plan** (no WETH `pampaloAssets` row / catalog token /
  notes / shield UI). The only client touch is the route encoder putting WETH
  in the v3 path for an ETH leg (the AMM pool is WETH/USDC). This is a
  **contract change in the venue subclass**, baked into the 3.0.0 redeploy (the
  separate Solidity session); the core `Pampalo.sol` is untouched.
- **A `swapEnabled` flag** (optionally `swapVerifier`/`venueAddress` for Sentry)
  is the only swap-specific deployment-row addition; `swap-prep` otherwise needs
  just the `pampalo` address + client-encoded route bytes.
- **`circuitVkHash` for both `0x86cC` and the new v3 contract is the unchanged
  `transfer_external` vk** (`0x20c6…7085`) — the standard circuits didn't change
  on the swap branch, so the client's bundled circuits work against the new
  contract and retired-note withdrawal from `0x86cC` verifies. Confirm on-chain
  post-deploy that the new contract's four standard verifiers match the bundled
  vks.
- **A future venue switch (v3 → v4) is a redeploy + ADR-0022 migration**, now
  over a real-money deployment — the eject path becomes load-bearing then.

## Related

- ADR 0023 — private swap lives in the immutable core (why a venue subclass *is*
  the deployment).
- ADR 0020 — fixed-output notes; v4 as the biggest audit risk.
- ADR 0017 / 0022 — clean-break redeploys and the retired-note eject this cutover
  relies on.
- `CONTEXT.md` — **Swap venue**, **Private swap**.
- `DEPLOYMENT.md` — the 8453 swap cutover runbook.
- `contracts/deployments/8453-swap.json` — the agent's validation-artifact
  addresses (not the live deployment).

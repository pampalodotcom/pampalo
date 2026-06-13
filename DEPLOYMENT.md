# Pampalo redeploy runbook

How to ship a new `Pampalo.sol` version end-to-end. Pampalo is
**non-upgradeable**: a redeploy is a new address + a fresh merkle tree, and
the old contract's on-chain state is abandoned (ADR 0017). This runbook is
the load-bearing process that keeps that clean break from silently
corrupting the app.

> **Network scope (current):** user-facing networks are **Base** + **Base
> Sepolia** only. Ethereum mainnet stays in the catalog `enabled: false`
> (backend-only) because it hosts the Chainlink price feeds + the
> Chainalysis sanctions oracle.

It has **three phases**:

- **Phase A — Deploy the new contract version.** Compile + deploy Pampalo,
  the four verifiers, the Poseidon2 hasher, the oracle adapters and the USDC
  mock; register supported assets; write the address artifact.
- **Phase B — Wire the new addresses into the app.** Update the **three**
  seeder sites from the artifact, then re-seed Convex (which archives + wipes
  the old deployment's rows).
- **Phase C — Retire the old contract.** Put the old contract into
  **wind-down** so users can still **Withdraw** retired notes (ADR 0022),
  re-grant per-contract roles, reseed backend accounts, and cut clients over.

Do the phases in order. Within a phase the steps are ordered too.

---

## Phase A — Deploy the new contract version

### A0. Before you deploy

- **Bump `VERSION`** in `contracts/contracts/Pampalo.sol` (semver). A
  breaking redeploy = MAJOR bump. Current: `2.0.0`.
- **Classify the bump — Solidity-only vs circuit-breaking.** If any circuit
  under `circuits/` changed (note layout, tree height, a verifier's vk), this
  is a **circuit-breaking** bump: old notes can only retire read-only, and the
  ADR-0022 **Withdraw** path is *not* offered for them. If only `Pampalo.sol`
  / oracle / role logic changed (as 1.x → 2.0.0 was), it's **circuit-compatible**
  and old notes stay withdrawable. Record which it is — it drives Phase C and
  the `circuitVkHash` seeder field (§B field table).
- **(Mainnet only) Drain the old contract first.** Have every user unshield
  their private notes back to public and cancel/finalise pending shields on
  the *current* app before repointing — otherwise their funds are stranded.
  On testnet this is skipped (re-shield, or Withdraw via ADR 0022).
- Run the contract tests: `pnpm --filter @pampalo/contracts test`.

### A1. Deploy

```
pnpm --filter @pampalo/contracts deploy:base-sepolia
```

`scripts/deploy.ts` runs seven idempotent steps (re-running on the same chain
is safe): (1) USDC mock via Ignition; (2) Pampalo + the 4 verifiers via
Ignition; (3) Poseidon2 huff hasher (raw bytecode); (4) `pampalo.setPoseidon`
if unset; (5) one `ChainlinkOracle` adapter per feed (ETH/USD, USDC/USD —
addresses + `maxAge` per chain in `CHAINLINK_FEEDS`); (6)
`addSupportedAsset(...)` for USDC + ETH; (7) writes
`contracts/deployments/<chainId>.json`.

> **Nonce flakiness (Base Sepolia / Alchemy):** if it dies with `HHE10404`
> "nonce should be N but is N-1", just **re-run** — the deploy resumes from
> the Ignition journal. Do **not** wipe the journal.

> **⚠ `fromBlock` gap.** `deployments/<chainId>.json` does **not** record the
> block Pampalo was deployed at, but all three seeders need it (it's the
> indexer cold-start cursor *and* the ADR-0022 Withdraw chain-sync start).
> Capture it now: the block of the Pampalo creation tx (Basescan, or the
> Ignition `journal.jsonl`). You'll hand-enter it as `fromBlock` in §B.

### A2. (Optional) Verify on Basescan

```
pnpm --filter @pampalo/contracts exec hardhat ignition verify pampalo --network baseSepolia
```

---

## Phase B — Wire the new addresses into the app

Every value below comes from `contracts/deployments/<chainId>.json` (plus the
`fromBlock` you captured in A1 and, for a circuit-breaking-aware gate, the
withdraw vk). The artifact for the current Base Sepolia deploy looks like:

```jsonc
{
  "chainId": 84532,
  "pampalo": "0x86cC…Af59",
  "poseidon2Huff": "0x55ed…AE4E",
  "verifiers": { "deposit": "0x04D2…Ce33", "transfer": "0xEDE2…1357",
                 "withdraw": "0x09e3…92A3", "transferExternal": "0x98f5…5e1D" },
  "tokens":  { "usdc": "0x445b…520d" },
  "oracles": { "usdc": "0xF1bC…7b2A", "eth": "0x84A4…85bE9" }
}
```

### B1. Update the three seeder sites

> **TODO (tooling):** `pnpm sync-deployment` to codegen these three sites
> from `<chainId>.json` in one command (chosen approach, not yet built — do
> it manually for now). When built, it should also fold in `fromBlock` and
> the withdraw `circuitVkHash`, which the artifact doesn't currently carry.

**Full field accounting** — artifact key → destination → field:

| Artifact key | `convex/shieldQueue/seed.ts` → `DEPLOYMENTS[chainId]` | `convex/catalog/seed.ts` → `TOKENS` (USDC row) | `sdk/src/deployments.ts` → `DEPLOYMENTS[chainId]` |
|---|---|---|---|
| `chainId` | `chainId` | `chainId` | `chainId` |
| `pampalo` | `pampalo` | — | `pampalo` (**lowercased**) |
| `poseidon2Huff` | `poseidon2Huff` | — | — |
| `verifiers.deposit` | `verifiers.deposit` | — | — |
| `verifiers.transfer` | `verifiers.transfer` | — | — |
| `verifiers.withdraw` | `verifiers.withdraw` | — | — |
| `verifiers.transferExternal` | `verifiers.transferExternal` | — | — |
| `tokens.usdc` | `assets[USDC].tokenAddress` | `address` | `tokens[USDC].address` |
| `oracles.usdc` | `assets[USDC].oracle` | — | — |
| `oracles.eth` | `assets[ETH].oracle` | — | — |
| `ETH_ADDRESS` (sentinel) | `assets[ETH].tokenAddress` | (static ETH row) | (n/a — ETH not a token row) |
| *(captured in A1)* `fromBlock` | `fromBlock` | — | `fromBlock` |

Values **not** from the artifact (set/confirm by hand):

| Field | Site | Value |
|---|---|---|
| `shieldWaitSeconds` | shieldQueue `DEPLOYMENTS` | mirror on-chain `shieldWaitTime` (`3600`). Display cache only — chain enforces. |
| `defaultMonthlyCapUsdCents` | shieldQueue `DEPLOYMENTS` | mirror on-chain (`200_00`). Display cache only. |
| `confirmationDepth` | shieldQueue `DEPLOYMENTS` | indexer trail: Base Sepolia `5`, Eth Sepolia `12`. |
| `sponsoringTxs` | shieldQueue `DEPLOYMENTS` | `true` only on chains the relayer sponsors (ADR 0015). Omit ⇒ false. |
| `assets[*].assetDecimals` | shieldQueue `DEPLOYMENTS` | USDC `6`, ETH `18`. Must match the on-chain `addSupportedAsset` decimals. |
| `separateDerivationKey` | sdk `DEPLOYMENTS` | Base Sepolia `false`; mainnets `true` (isolated slot-420 envelope key). |
| `name / symbol / decimals / roundTo` | catalog `TOKENS` | static token metadata; carry over from the prior row. |
| **`circuitVkHash`** *(ADR 0022 — see B3)* | shieldQueue `DEPLOYMENTS` | hex of `circuits/withdraw/target/vk_hash`. Gates the Withdraw button on a circuit-compat match. |

### B2. Re-seed Convex

> **Gate (ADR 0018):** the retired-note **archive** code (archive tables +
> `seedAll`'s archive-before-wipe step) must already be **deployed** before
> you run `seedAll`. If the wipe runs without it, the old deployment's rows
> are destroyed and retired-note history collapses to whatever each device
> cached. Confirm `convex/schema.ts` carries `archivedShieldQueue` /
> `archivedTransferNotes` / `archivedDeployments` and the deploy is live.

```
npx convex run catalog/seed:seedAll          # networks (Base-only) + tokens
npx convex run shieldQueue/seed:seedAll      # deployment row + assets
```

`shieldQueue/seed:seedAll` **auto-detects the address change** (old `pampalo`
≠ new, and old ≠ `""`). On a changed address it, in order: (1) **archives**
the user-recoverable rows — `shieldQueueEntries → archivedShieldQueue`,
`transferNotes → archivedTransferNotes`, plus an `archivedDeployments`
identity marker; (2) **wipes** the old deployment's orphaned indexed rows
(`pampaloLeaves`, `shieldQueueEntries`, `transferNotes`, `pampaloActivity`)
and resets the indexer cursor. The wipe is **required** — without it the new
tree's leaf 0 collides with the stale old leaf 0 and proofs break (ADR 0017).
Look for the `[seed] redeploy … archived … then wiped …` log line.

### B3. (ADR 0022) Persist what the Withdraw path needs

The ADR-0022 **Withdraw** button rebuilds the *old* tree from chain and only
shows on a circuit-compatible bump. That needs two values to survive into the
**old** deployment's archive marker:

- **`fromBlock`** — the old contract's deploy block, so the client chain-sync
  knows where to start (the Convex leaf mirror is wiped). *Currently
  `pampaloDeployments` only stores `lastIndexedBlock`*, so persist `fromBlock`
  on the deployment row (seeded from `DEPLOYMENTS[chainId].fromBlock`) and
  copy it into `archivedDeployments` in `archiveDeploymentChildren`.
- **`circuitVkHash`** — the old withdraw-circuit vk identity, so the client
  can compare it to its bundled circuit and offer Withdraw only on a match.
  Seed it on the deployment row and copy it into `archivedDeployments`.

> These two fields + the `archivedDeployments` schema additions are the only
> code the ADR-0022 Withdraw feature adds to the **deploy** path. Rows
> archived before they exist simply show read-only (status quo) — it degrades
> safely.

---

## Phase C — Retire the old contract

### C1. Wind down the old contract on-chain (ADR 0022)

So users can later **Withdraw** retired notes without hitting a cap wall, run
these on the **old** Pampalo address (from the ledger below). The deployer
still holds `DEFAULT_ADMIN_ROLE` + `FINANCE_MANAGER_ROLE` there.

- `pampalo.weAreFull()` — halts further `shield`/`shieldNative` into the dead
  contract. Does **not** gate `unshield`/`cancelShield`, so withdrawals keep
  working.
- `pampalo.setDefaultMonthlyCap(<huge, e.g. type(uint64).max>)` — lifts the
  unshield ceiling so even a single over-$200 note (notes are atomic) can
  exit. No compliance cost: it's a deprecated-contract drain back to the
  user's own public address, not a fresh crossover.

> Skip C1 on a **circuit-breaking** bump — those notes can't be withdrawn
> (the old verifier rejects the new circuit's proofs), so they retire
> read-only and the mainnet drain-before-cutover (A0) is the only recovery.

### C2. Re-grant roles (per-contract — ADR 0016/0017)

```
pnpm --filter @pampalo/contracts grant-roles:base-sepolia
```

Grants `VIGILANT_CITIZEN_ROLE` / `FINANCE_MANAGER_ROLE` / `BOOTH_OPERATOR_ROLE`
to the ops target (`TARGET` in `scripts/grant-roles.ts`) **and**
`VIGILANT_CITIZEN_ROLE` to the compliance signer (index 5 of
`RELAYER_MNEMONIC`). Idempotent. The deployer keeps `DEFAULT_ADMIN_ROLE`.
Relayer/compliance EOAs are deterministic from the mnemonic, so their testnet
ETH **persists** — no re-funding.

### C3. Reseed backend account rows

```
npx convex run relayer/node:seedRelayerAccounts '{"chainId":84532}'
npx convex run compliance/node:seedComplianceSigner '{"chainId":84532}'
```

### C4. Client cutover — no `/clear` needed (ADR 0018)

Old-tree notes in a wallet's IndexedDB **auto-retire** (their
`deploymentAddress` is no longer in `enabledDeployments()`), drop out of the
spend picker + spendable balance, and surface read-only under **Account →
Previous deployments**. The only user action is **Sync** (or sign in again),
which pulls new-contract notes and repopulates retired history from the
archive. `/clear` is **not** part of the cutover and never touched the notes
store.

---

## Verify

- `/sentry` shows the new deployment with `0` queued shields and an empty
  pool-activity feed (old rows wiped).
- The Vigilant Citizen bot panel shows the compliance signer as **green
  "Vigilant Citizen"** (role granted).
- On a wallet that held notes on the old contract: those notes no longer
  appear as spendable, the spendable balance excludes them, and they show
  read-only under **Account → Previous deployments** (ADR 0018). On a fresh
  device, a Sync repopulates that same retired history from the archive.
- A test shield → unshield round-trips on the new contract.
- *(circuit-compatible bumps)* On a wallet with retired notes, **Withdraw**
  on the Previous-deployments card exits a note to the signed-in address.
- The deployment ledger below is updated.

## Deployment ledger

| Version | Chain | Pampalo address | Deployer | Date | Notes |
|---|---|---|---|---|---|
| 1.x | Base Sepolia (84532) | `0x3E6dfc4c233486A44e26A548e191c839f069037f` | `0x19fD…c95c` (idx 0) | 2026-05-29 | initial |
| 2.0.0 | Base Sepolia (84532) | `0x86cC802B2d5a9EF41194E68ed69EeCC37AdAAf59` | `0x77c2…f054` (idx 1) | 2026-06-12 | $200 cap, `unshieldBudget()`, fast-track, `cancelShield` relaxation, Base-only networks. Index-1 nonce-0 deployer so Base mainnet gets the same address. |

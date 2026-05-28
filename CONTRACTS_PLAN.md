# Contracts Plan

How to bring the on-chain half of Pampalo up to parity with — and ahead of
— `hooperben/commbank.eth` PR #26 (`ben/scaling` → `dev`,
"Functionality Infinite Private Money Trees"), and where the
`contracts/README.md` compliance surface gets stitched in.

The source PR is the canonical reference for the cryptographic core
(Poseidon Merkle tree, deposit / transfer / withdraw / transferExternal
verifier wiring, note payload encryption). Pampalo's deltas all live on
top of that core — they are additive guardrails (deposit holds, monthly
caps, supported-asset whitelist, kill switch), not changes to the proof
system.

---

## 1. Source PR inventory

PR: <https://github.com/hooperben/commbank.eth/pull/26>
Head branch: `ben/scaling`. 12 commits. Headline change: the merkle tree
rolls over into a fresh "epoch" tree when it fills, and every historical
root remains permanently valid.

### 1.1 Solidity (the only files we must port verbatim)

| Source path | Purpose |
|---|---|
| `contracts/contracts/CommBankDotEth.sol` | The protocol entrypoint. `deposit`, `depositNative`, `transfer`, `withdraw`, `transferExternal`. Holds nullifier mapping. Inherits `PoseidonMerkleTree` + OZ `AccessControl`. Uses one `IVerifier` per circuit. Emits `NullifierUsed` and `NotePayload`. |
| `contracts/contracts/PoseidonMerkleTree.sol` | Append-only Poseidon2 merkle tree with **epoch rollover**. `TREE_HEIGHT = 12`, `MAX_LEAF_INDEX = 1 << 11`. `filledSubtrees` is keyed by `(epoch << 64) \| (level << 32) \| index` so epochs cannot collide. `knownRoots[r]` is permanent: any historical root remains a valid membership root forever. Zero-leaf seeded as `keccak256("TANGERINE") % BN254_PRIME`. `setPoseidon` is one-shot and seeds the `zeros[]` table + initial root. |
| `contracts/contracts/mocks/TestablePoseidonMerkleTree.sol` | Exposes `_insert` and `setNextIndex` so rollover can be tested without paying for 2¹¹ real inserts. |
| `contracts/contracts/verifiers/{Deposit,Transfer,TransferExternal,Withdraw}Verifier.sol` | Generated UltraHonk verifiers. **Already present in `contracts/contracts/verifiers/` — built from the circuits already in `circuits/`. Do not regenerate; the verifier bytecode is what the circuit JSON commits to.** |

### 1.2 Circuits

| Source path | Purpose |
|---|---|
| `circuits/pum_lib/src/lib.nr` | Tree height + Poseidon helpers (`calculate_leaf`, `compute_merkle_root`, `compute_nullifier`, `reconstruct_leaf`). `HEIGHT = 12`. |
| `circuits/{deposit,transfer,transfer_external,withdraw}/src/main.nr` | The four circuits. Pampalo's copies under `circuits/` are already at parity (confirmed: `pum_lib::HEIGHT = 12` matches the on-chain `TREE_HEIGHT = 12`). **No work to do here for this task.** |

### 1.3 TypeScript helpers (Hardhat test harness)

| Source path | Purpose |
|---|---|
| `contracts/helpers/get-testing-api.ts` | One fixture call that deploys CBE + tokens + Poseidon2 huff hasher, wires `setPoseidon`, builds the off-chain merkle tree, and returns Noir/UltraHonk classes for all four circuits. |
| `contracts/helpers/tree-config.ts` | `TREE_HEIGHT = 12`, `MAX_LEAF_INDEX`. Single TS-side source of truth — must match `pum_lib::HEIGHT` and `PoseidonMerkleTree.TREE_HEIGHT`. |
| `contracts/helpers/objects/poseidon-merkle-tree.ts` | Off-chain mirror of the tree with file-cache (`./cache/full-tree-h12.json`) so test boot doesn't recompute 2¹² zero hashes every run. |
| `contracts/helpers/objects/get-noir-classes.ts` | Lazily constructs one shared `Barretenberg` instance and four `Noir` + `UltraHonkBackend` pairs. Exposes `destroyNoirApi()` for the global teardown. |
| `contracts/helpers/functions/{deposit,transfer,withdraw}.ts` | Witness builders + proof generators + on-chain tx wrappers. `transfer.ts` also exposes `createDepositPayload` (encrypt-to-recipient for the `NotePayload` emit). |

### 1.4 Tests

| Source path | Purpose |
|---|---|
| `contracts/test/_teardown.test.ts` | Global mocha `after()` hook that calls `destroyNoirApi()` and `destroyAllBb()`. Without this the bb.js worker thread keeps the event loop alive and mocha never exits. **Required.** |
| `contracts/test/deposit.test.ts` | Three cases: ERC20 deposit (asserts both token balance delta and root match against off-chain tree), native ETH deposit (asserts contract ETH balance delta and gas-adjusted user balance), and an explicit "hash matches the noir test vector" case. |
| `contracts/test/epoch-rollover.test.ts` | Exercises the new epoch behaviour: initial empty-tree root is permanently `knownRoots`; `setPoseidon` is one-shot; one insert advances `nextIndex` and adds a new root while keeping the old one valid; off-chain TS tree matches on-chain root after N inserts; rollover at `MAX_LEAF_INDEX` emits `EpochRolledOver(0, finalRoot)` and the next `LeafInserted` is `(epoch=1, index=0)`; multiple rollovers preserve every historical root; a fresh epoch's one-leaf root equals an independent TS-side tree's one-leaf root. |

### 1.5 Shared package (`shared/`)

| Source path | Purpose |
|---|---|
| `shared/classes/{Deposit,Transact,Withdraw,TransferExternal}.ts` | One class per circuit. Each owns a `Noir` instance and a lazily-initialised `UltraHonkBackend`. The Hardhat helpers in `contracts/helpers/functions/*.ts` delegate to these. |
| `shared/classes/bb-api.ts` | Singleton `getBbApi()` returning a shared `Barretenberg` instance. |
| `shared/classes/bb-teardown.ts` | `destroyAllBb()` — companion to `destroyNoirApi`, called from the teardown test. |

### 1.6 Out of scope for this milestone

The PR also adds an `indexer/`, a `stress/` Docker-based harness, and
CI changes. **None of these are part of this task.** Stress and
indexer can be ported later once the on-chain primitives compile and
the test suite is green; CI lives in `.github/workflows/` and is a
separate concern.

---

## 2. Repository layout: source vs target

Commbank.eth is a pnpm monorepo with three workspaces: `contracts/`,
`shared/`, `stress/`. Pampalo's `pnpm-workspace.yaml` currently lists
two: `contracts` and `docs-site`. Two structural choices to make
before writing code:

**Recommended:** keep everything inside `contracts/` for v1 — `Deposit`,
`Withdraw`, `Transact`, `TransferExternal`, `bb-api`, `bb-teardown` all
land under `contracts/helpers/classes/` (or similar). No new pnpm
workspace. Rationale: nothing outside the Hardhat tests consumes those
classes yet, and the wallet half of Pampalo already has its own bb.js
plumbing in `src/lib/`. We can promote to a `shared/` workspace if and
when a second consumer appears.

**Path alias:** the source uses `@/helpers/...` (`@/` = `contracts/`).
The Pampalo `contracts/tsconfig.json` is the place to set this — the
existing `contracts/test/helpers/get-testing-api.ts` currently uses
relative `../../` paths, but porting the helpers verbatim is much
easier with an alias. Add a `paths` entry: `"@/*": ["./*"]` with
`baseUrl: "."` and move `helpers/` to `contracts/helpers/` (it is
under `contracts/test/helpers/` today — move it up one level to match
the source layout).

---

## 3. Naming & symbol map

| Source | Pampalo |
|---|---|
| `CommBankDotEth.sol` (contract + filename) | `PampaloPrivateMoneyV1.sol` (contract + filename) |
| `commbankDotEth` (TS variable, ignition module return key) | `pampaloPrivateMoneyV1` |
| `CommbankDotEthModule` (`ignition/modules/CommbankDotEth.ts`) | `PampaloPrivateMoneyV1Module` (`ignition/modules/PampaloPrivateMoneyV1.ts`) |
| `DEPOSIT_ROLE` | Keep — also add `VIGILANT_CITIZEN_ROLE`, `FINANCE_MANAGER_ROLE` (see §4). |
| `import "@openzeppelin/contracts/access/AccessControl.sol"` | `AccessControlEnumerable.sol` per `contracts/README.md` §Libraries. Gives us `getRoleMember`/`getRoleMemberCount` for the "show all vigilant citizens" view. |
| ASCII banner comment in source `.sol` | Remove. Replace with a one-line `@title` + `@notice` NatSpec. |

Storage variable names (`depositVerifier`, `transferVerifier`,
`withdrawVerifier`, `transferExternalVerifier`, `nullifierUsed`,
`NOTES_INPUT_LENGTH`, `EXIT_*_INDEX`, `ETH_ADDRESS`) stay as-is.

---

## 4. Pampalo-specific deltas (from `contracts/README.md`)

These are the additions that make the v1 contract **Pampalo**, not just
a CBE rename. All are additive — none change the proof system or the
public-input layout.

### 4.1 Deposit wait time & contestation

Replace the immediate `_insert` in `deposit` / `depositNative` with a
queue.

```
struct PendingDeposit {
  address depositor;        // who can cancel
  address asset;            // 0xEee for native
  uint256 amount;           // wei / token base units
  uint256 leafCommitment;   // _publicInputs[0]
  bytes32 payloadHash;      // keccak of encoded payload, for later emit
  uint64  unlockTime;       // block.timestamp + WAIT
  bool    cancelled;
}
mapping(uint256 => PendingDeposit) public pendingDeposits;
mapping(uint256 => bytes[]) private _pendingPayloads; // small, deleted on flush
uint256 public nextPendingId;
uint256 public depositWaitTime = 1 hours; // settable by FINANCE_MANAGER_ROLE

event DepositQueued(uint256 indexed id, address indexed depositor, uint256 unlockTime);
event DepositExecuted(uint256 indexed id);
event DepositCancelled(uint256 indexed id, address indexed by);
event DepositContested(uint256 indexed id, address indexed by, string reason);
```

Surface:

- `deposit` / `depositNative` verify the proof and the asset/amount
  match (same checks as today), **escrow** the funds (token transfer
  or `msg.value`), assign a `pendingId`, store everything, and emit
  `DepositQueued`. They do **not** call `_insert` yet.
- `executeDeposit(uint256 id)` (anyone may call after `unlockTime`)
  inserts the leaf, emits the encrypted `NotePayload`(s), and frees
  storage.
- `cancelDeposit(uint256 id)` — depositor-only, refunds the escrow,
  marks cancelled. No leaf was ever inserted, so no nullifier work.
- `contestDeposit(uint256 id, string reason)` — `VIGILANT_CITIZEN_ROLE`
  only. Same effect as `cancelDeposit` (refund + cancel) but emits
  `DepositContested` instead. Decide whether the refund goes to the
  original depositor or to a treasury — pick depositor for v1 to keep
  the spec "we can't take your money".
- ETHGlobal NYC 2026 booth bypass: a single `FINANCE_MANAGER_ROLE`-only
  `executeDepositImmediate(uint256 id)` that skips the unlock check.
  Same role can set `depositWaitTime` via a setter so the bypass can
  also be flipped to zero globally.

Vigilant-citizen dashboard ergonomics: emit `DepositQueued` with enough
indexed fields that an off-chain indexer can list "all pending
deposits", and rely on `AccessControlEnumerable` for the citizen
roster. No on-chain enumeration of pending IDs (cheaper, easier).

### 4.2 Monthly $100 encrypt + decrypt caps per address

State:

```
struct MonthlyVolume { uint64 month; uint192 usdCentsUsed; }
mapping(address => MonthlyVolume) public encryptUsage; // for deposit
mapping(address => MonthlyVolume) public decryptUsage; // for withdraw + transferExternal
uint256 public defaultMonthlyCapUsdCents = 100_00;
mapping(address => uint256) public addressMonthlyCapUsdCents; // 0 = use default
```

Helpers:

- `_currentMonth()` → `block.timestamp / 30 days` is **not** "first of
  the month forever". To honour the spec, compute calendar months from
  the unix timestamp using a small `BokkyPooBahsDateTime`-style helper,
  or accept the 30-day approximation explicitly in a comment. Pick the
  approximation for v1 unless we want to add a date lib; document the
  drift in the contract NatSpec.
- `_chargeEncrypt(address user, address asset, uint256 amount)` — looks
  up the chainlink price for `asset`, converts to USD cents, asserts
  `used + cost <= cap`, updates `MonthlyVolume`. Same shape for
  `_chargeDecrypt`.

Wire:

- `deposit` / `depositNative`: `_chargeEncrypt(msg.sender, asset,
  amount)` **before** queueing. (If the deposit is later cancelled or
  contested, the cap is **not** refunded — this is intentional, it
  prevents grief-cycling against the cap and matches the "soft" cap
  spirit. Document.)
- `withdraw` / `transferExternal`: `_chargeDecrypt` on the **net
  externalised value** — sum of `exitAmount * price` for each non-zero
  exit slot. Charge against the `msg.sender` of the transaction (the
  relayer/payer), not against an "exit address" — the externalised
  recipient is a public field on a privacy contract; charging it would
  leak.

Admin: `FINANCE_MANAGER_ROLE` can call
`setAddressMonthlyCap(address, uint256 usdCents)` and
`setDefaultMonthlyCap(uint256 usdCents)`. README explicitly calls this
out.

### 4.3 Supported assets + Chainlink oracles

```
struct AssetConfig {
  address priceFeed;     // chainlink AggregatorV3Interface
  uint8   feedDecimals;  // cached from feed.decimals() at register time
  uint8   assetDecimals; // 18 for ETH, 6 for USDC, etc.
  bool    enabled;
}
mapping(address => AssetConfig) public supportedAssets;
event AssetSupported(address indexed asset, address priceFeed);
event AssetDisabled(address indexed asset);
```

- `addSupportedAsset(address asset, address priceFeed, uint8
  assetDecimals)` — `FINANCE_MANAGER_ROLE` only.
- `disableSupportedAsset(address asset)` — same role.
- `_assetUsdCents(address asset, uint256 amount)` — read the
  AggregatorV3 `latestRoundData`, sanity-check `answer > 0` and
  staleness (`updatedAt + maxAge > block.timestamp`; expose `maxAge`
  as a per-asset setting, default 1 hour).
- `deposit` / `depositNative` / `withdraw` / `transferExternal` all
  require `supportedAssets[asset].enabled`.

### 4.4 `weAreFull()` kill switch

```
bool public depositsHalted;
event DepositsHalted(address indexed by);
event DepositsResumed(address indexed by);

modifier whenDepositsOpen() {
  require(!depositsHalted, "deposits halted");
  _;
}
```

- `weAreFull()` — `FINANCE_MANAGER_ROLE` only, sets the flag, emits.
- `weAreNotFull()` — same role, clears it. README only mentions the
  setter, but a clear-it counterpart is operationally necessary;
  document that calling it is a policy decision.
- Apply `whenDepositsOpen` to `deposit` and `depositNative` only.
  `executeDeposit`, `cancelDeposit`, `contestDeposit`, `transfer`,
  `withdraw`, `transferExternal` continue to work — exactly the
  README's promise ("Users can still transfer and withdraw their
  funds — but cannot encrypt anymore").

### 4.5 Roles summary

| Role | Granted in constructor to | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | deployer | Grant/revoke all roles |
| `DEPOSIT_ROLE` | deployer | (existing) call `deposit` / `depositNative`. Keep as-is. |
| `VIGILANT_CITIZEN_ROLE` | deployer | `contestDeposit` |
| `FINANCE_MANAGER_ROLE` | deployer | Monthly caps, supported assets, `weAreFull`/`weAreNotFull`, `executeDepositImmediate`, `setDepositWaitTime` |

`AccessControlEnumerable` lets the front-end render "all vigilant
citizens" / "all finance managers" without an off-chain indexer.

---

## 5. Public-input layout & verifier compatibility — **don't drift**

The four verifiers already in `contracts/contracts/verifiers/` are
exactly the ones the PR ships with, and they are bound to the circuit
JSON via the verification-key hash. **Do not change**:

- `NOTES_INPUT_LENGTH = 3`
- `EXIT_ASSET_START_INDEX = 4`, `EXIT_AMOUNT_START_INDEX = 7`,
  `EXIT_ADDRESSES_START_INDEX = 10`
- The transfer-external slot map (root @ 0; nullifiers @ 1–3; output
  hashes @ 4–6; exit assets @ 7–9; exit amounts @ 10–12; exit addresses
  @ 13–15; followed by exit address hashes — confirmed in the source
  contract's comment block).
- The deposit slot map (`hash @ 0`, `asset_id @ 1`, `asset_amount @ 2`).

The `exit_address_hashes` public input is what gives the
transfer-external / withdraw flows mempool frontrun resistance — the
contract enforces nothing about them directly (the proof does), but
they **must** still appear in `_publicInputs` in the position the
verifier expects. Easy to break this with a "cleanup" — don't.

---

## 6. Phased execution plan

Each phase ends green (`pnpm --filter @pampalo/contracts test`) before
the next starts.

### Phase 0 — scaffolding (no behaviour change)

- `contracts/tsconfig.json`: add `baseUrl: "."` and `"paths": { "@/*":
  ["./*"] }`.
- Move `contracts/test/helpers/` → `contracts/helpers/`. Update the one
  import in `contracts/test/hello.test.ts`.
- `contracts/package.json`: add deps the harness needs — `@aztec/bb.js`,
  `@noir-lang/noir_js`, `@zkpassport/poseidon2`,
  `@openzeppelin/contracts`. (Verify versions against the circuit
  artefacts under `circuits/*/target/`.)
- Drop a placeholder `contracts/contracts/utils/Poseidon2Huff.json` —
  this is the **prebuilt huff bytecode** the source repo ships and we
  need it byte-for-byte (the contract is deployed via `ContractFactory`
  from raw bytecode, not compiled from source). Copy from the
  commbank.eth repo at the matching commit.

### Phase 1 — port the core, unchanged

- `contracts/contracts/PoseidonMerkleTree.sol` — copy verbatim.
- `contracts/contracts/mocks/TestablePoseidonMerkleTree.sol` — copy
  verbatim.
- `contracts/contracts/PampaloPrivateMoneyV1.sol` — copy
  `CommBankDotEth.sol`, rename per §3, no behaviour change yet.
- `contracts/ignition/modules/PampaloPrivateMoneyV1.ts` — model on
  `CommbankDotEth.ts` (PR has it; fetch if needed). Also write
  `ignition/modules/Tokens.ts` (USDC mock + 4-decimal mock — the source
  ships these).
- Port `helpers/get-testing-api.ts`, `helpers/tree-config.ts`,
  `helpers/objects/{poseidon-merkle-tree,get-noir-classes}.ts`,
  `helpers/functions/{deposit,transfer,withdraw}.ts`. Update imports
  to point at the local `circuits/*/target/*.json` (the source uses
  `../../../circuits/...`; ours is the same relative depth).
- Port the four `shared/classes/{Deposit,Transact,Withdraw,TransferExternal}.ts`
  + `bb-api.ts` + `bb-teardown.ts` under `contracts/helpers/classes/`
  (or as a `shared/` workspace if we decided otherwise in §2).
- Port `test/_teardown.test.ts`, `test/deposit.test.ts`,
  `test/epoch-rollover.test.ts`.
- Delete `HelloWorld.sol`, its ignition module, and `hello.test.ts`
  once parity is green.

**Exit criteria:** `pnpm test` passes both ported test files end to end
on the in-process Hardhat network. (`epoch-rollover.test.ts` is pure
Solidity + TS tree; `deposit.test.ts` exercises the full Noir prover
path and will be the first signal that the bb.js / circuit-artefact
plumbing is wired correctly.)

### Phase 2 — Pampalo compliance (§4)

In order, each with its own focused test file:

1. `test/access-control.test.ts` — role bootstrap, grant/revoke,
   `AccessControlEnumerable` views.
2. `test/supported-assets.test.ts` — register/disable, deposit rejects
   unsupported asset, oracle staleness check.
3. `test/deposit-wait.test.ts` — `deposit` queues + escrows;
   `executeDeposit` before unlock reverts; `executeDeposit` after
   unlock inserts + emits payload; `cancelDeposit` refunds;
   `contestDeposit` from a non-citizen reverts; `contestDeposit` from a
   citizen refunds + emits; `executeDepositImmediate` (booth bypass)
   inserts immediately.
4. `test/monthly-caps.test.ts` — encrypt cap blocks an over-limit
   deposit; cap rolls over on month boundary; per-address cap override;
   decrypt cap on `withdraw` and `transferExternal`; cancelled deposits
   do **not** refund the cap (intentional, asserted).
5. `test/we-are-full.test.ts` — `weAreFull` blocks new deposits;
   pending deposits can still `executeDeposit`; transfers and
   withdrawals still work; `weAreNotFull` clears.

### Phase 3 — port the transfer/withdraw/transferExternal end-to-end tests

The source PR ships their tests adjacent to `deposit.test.ts` (not
listed in §1.4 — they're under `contracts/test/` in earlier commits on
`dev`). Port them once Phase 1 is green, and update them to go through
the new "execute after wait" flow (or use `executeDepositImmediate`)
to seed notes for the spend paths.

### Phase 4 — deployment + verification

- Hardhat `ignition` deploy script for Sepolia first, then Base. Verify
  on Etherscan/Basescan via the existing `ETHERSCAN_API_KEY`-driven
  `verify` block in `hardhat.config.ts`.
- The Poseidon2 huff contract has to be deployed first; capture its
  address; pass it to `setPoseidon`.

---

## 7. Known gotchas

- **Poseidon2 huff bytecode is prebuilt.** It is not compiled from a
  `.sol` file — it ships as a JSON blob and is deployed via
  `ContractFactory([], bytecode, signer)`. The exact bytecode is what
  the circuit's hash gadget expects; substituting another Poseidon
  implementation will silently produce wrong roots. Copy it from
  `hooperben/commbank.eth/contracts/contracts/utils/Poseidon2Huff.json`
  at the same commit as the verifiers.
- **Tree cache.** `getMerkleTree()` caches a built tree to
  `./cache/full-tree-h12.json`. Add `contracts/cache/` to the
  `.gitignore` (the existing one already covers `cache/` — confirm).
  First test run will take a noticeable second or two; subsequent runs
  are near-instant.
- **bb.js teardown.** Without `_teardown.test.ts` the Hardhat process
  will hang after `passing` and CI will time out. Don't skip it.
- **`@/` alias resolution in tests.** Hardhat 3 + mocha picks up
  `tsconfig.json` paths via `tsx` — make sure the contracts
  `tsconfig.json` has `"moduleResolution": "Bundler"` or the equivalent
  so the alias resolves at runtime, not just at type-check time. If
  paths refuse to resolve, fall back to relative imports — they're
  ugly but unblock the port.
- **Verifier solc range.** The verifiers declare `pragma solidity
  >=0.8.21`. Our compiler is pinned at `0.8.28` — compatible. The new
  `PampaloPrivateMoneyV1.sol` and `PoseidonMerkleTree.sol` should
  declare `^0.8.24` (matching the source) or `^0.8.28` (matching our
  pin) — either works; pick `^0.8.24` to keep diffability with the
  source.
- **`epoch` semantics.** The PR's epoch counter is **per-tree**, not
  per-day or per-month. Don't conflate it with `_currentMonth()` in
  the cap logic.
- **`exit_address_hashes`** — see §5. Easy to "tidy away" by mistake.

---

## 8. What we are explicitly **not** doing in v1

- `indexer/` — Pampalo already has a Convex backend; we'll add the
  deposit/transfer/withdraw event ingestion there separately.
- `stress/` — useful, but a Docker harness is a follow-up.
- Multi-deposit batching, governance over `depositWaitTime` (a single
  setter is fine for v1), per-asset caps (USD-denominated caps are
  asset-agnostic by design).
- Removing `DEPOSIT_ROLE`. The README doesn't address it; keep the
  source's behaviour and revisit once the deposit-wait flow is in.

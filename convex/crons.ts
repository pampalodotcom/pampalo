import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "clean expired pending + sessions",
  { minutes: 5 },
  internal.auth.ceremony.cleanupExpired,
  {},
);

// Convex's cron floor is 1 min; refreshPrices self-schedules a +30s
// shadow tick so we effectively poll every 30s. See prices/refresh.ts
// for the SHADOW_DELAY_MS comment. Dedupe in prices/feeds._writeRefresh
// skips writing history rows when the answer is unchanged.
crons.interval(
  "refresh chainlink prices",
  { minutes: 1 },
  internal.prices.refresh.refreshPrices,
  {},
);

// Gas moves faster — 1 min is the cron floor anyway. Dedupe is on the
// gasPriceWei value, so a chain at steady-state writes one history row
// per actual gas-price move, not every minute.
crons.interval(
  "refresh gas prices",
  { minutes: 1 },
  internal.prices.refresh.refreshGas,
  {},
);

// Per-deployment shield-queue indexer. 1-min cron + self-scheduled
// +30s shadow tick ⇒ ~30s effective cadence. See SHIELD_FLOW.md §5
// and convex/shieldQueue/refresh.ts for the rationale.
crons.interval(
  "refresh shield queue",
  { minutes: 1 },
  internal.shieldQueue.refresh.refreshShieldQueue,
  {},
);

// Relayer pool balance reconciliation — corrects optimistic-deduction
// drift against eth_getBalance. See TRANSFERS.md §5.
crons.interval(
  "reconcile relayer balances",
  { minutes: 15 },
  internal.relayer.reconcile.reconcileBalances,
  {},
);

// Zombie-lock reaper — force-releases relayer accounts stuck busy past
// the 60s threshold (crashed/hung relay actions). See TRANSFERS.md §3.4.
crons.interval(
  "reap relayer zombie locks",
  { minutes: 1 },
  internal.relayer.store.reapZombieLocks,
  {},
);

// Compliance scan — screen queued shielders against the blocklist + the
// Chainalysis oracle, auto-contesting matches before the shield wait
// elapses. Detect-and-log only until COMPLIANCE_AUTO_CONTEST=1. The 1h
// default wait leaves ample room for a 2-min cadence. See ADR 0016.
crons.interval(
  "scan shields for compliance",
  { minutes: 2 },
  internal.compliance.node.scanAndContest,
  {},
);

// Chainalysis sanctions-oracle indexer — backfills from the oracle's deploy
// block (day 1) then stays at head, mirroring its add/remove events into
// blockedAddresses. Hourly: sanctions lists change slowly. See ADR 0016.
crons.interval(
  "index chainalysis oracle",
  { hours: 1 },
  internal.compliance.oracle.indexChainalysisOracle,
  {},
);

// Published-list ingest (Railgun / OFAC) — no-op unless the operator has
// set the corresponding *_BLOCKLIST_URL env vars. Daily; these lists are
// slow-moving.
crons.interval(
  "ingest compliance lists",
  { hours: 24 },
  internal.compliance.oracle.ingestConfiguredLists,
  {},
);

export default crons;

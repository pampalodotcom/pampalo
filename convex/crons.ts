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

export default crons;

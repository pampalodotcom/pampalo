import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "clean expired pending + sessions",
  { minutes: 5 },
  internal.auth.cleanupExpired,
  {},
);

// Chainlink fiat-pair feeds rarely move faster than this — 5 min keeps
// the latest row fresh without burning RPC budget. Dedupe in
// prices._writeRefresh skips writing history rows when the answer is
// unchanged.
crons.interval(
  "refresh chainlink prices",
  { minutes: 5 },
  internal.refresh.refreshPrices,
  {},
);

// Gas moves faster — 1 min is the cron floor anyway. Dedupe is on the
// gasPriceWei value, so a chain at steady-state writes one history row
// per actual gas-price move, not every minute.
crons.interval(
  "refresh gas prices",
  { minutes: 1 },
  internal.refresh.refreshGas,
  {},
);

export default crons;

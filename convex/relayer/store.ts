import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { lowerAddress } from "../lib/normalize";
import { resolveMinBalanceWei } from "../lib/relayerFloor";
import { sessionByTokenOrNull } from "../auth/ceremony";

// Default-runtime queries + mutations for the gas-sponsoring relayer pool.
// The signing/broadcasting half lives in relayer/node.ts ("use node");
// this file holds only DB-side logic so it can run in the fast Convex
// runtime and be called via ctx.runQuery/runMutation from the action.
//
// The atomic acquire/release pair is the mutex that guarantees two
// concurrent relays never collide on the same account (TRANSFERS.md §3.3).

const ZOMBIE_LOCK_MS = 60_000;

// ─── Auth (rate-limit gate only; no userId→tx row is ever written) ─────────

/** Resolve a session token to its userId, or null if invalid/expired. The
 *  relay action gates on this purely so anonymous callers can't spend the
 *  pool's gas; per TRANSFERS.md §2.3 nothing ties the userId to a tx. */
export const _userIdForSession = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args): Promise<Id<"users"> | null> => {
    const session = await sessionByTokenOrNull(ctx, args.sessionToken);
    return session?.userId ?? null;
  },
});

// ─── Deployment lookup (relayer-flavoured) ─────────────────────────────────

export type RelayerDeployment = {
  pampalo: string;
  alchemySubdomain: string;
  chainId: number;
  sponsoringTxs: boolean;
  minRelayerBalanceWei: string;
};

/** Like shieldQueue._deploymentForChain but also surfaces the sponsoring
 *  config. Returns null when the chain has no enabled deployment. */
export const _relayerDeploymentForChain = internalQuery({
  args: { chainId: v.number() },
  handler: async (ctx, args): Promise<RelayerDeployment | null> => {
    const net = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!net) return null;
    const dep = await ctx.db
      .query("pampaloDeployments")
      .withIndex("by_networkId", (q) => q.eq("networkId", net._id))
      .unique();
    if (!dep || !dep.enabled) return null;
    return {
      pampalo: dep.pampalo,
      alchemySubdomain: net.alchemySubdomain,
      chainId: net.chainId,
      sponsoringTxs: dep.sponsoringTxs ?? false,
      // Resolved to wei here so the acquire-lock comparison (and the relay
      // action that passes this through) sees the live USD-denominated floor.
      minRelayerBalanceWei: await resolveMinBalanceWei(ctx, dep),
    };
  },
});

/** All sponsoring chains' subdomains — drives the reconcile cron. */
export const _sponsoringChains = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<Array<{ chainId: number; alchemySubdomain: string }>> => {
    const deps = await ctx.db.query("pampaloDeployments").collect();
    const out: Array<{ chainId: number; alchemySubdomain: string }> = [];
    for (const d of deps) {
      if (!d.enabled || d.sponsoringTxs !== true) continue;
      const net = await ctx.db.get(d.networkId);
      if (!net) continue;
      out.push({ chainId: net.chainId, alchemySubdomain: net.alchemySubdomain });
    }
    return out;
  },
});

// ─── Acquire / release mutex ───────────────────────────────────────────────

/** Atomically pick the least-recently-used idle + funded account on a
 *  chain and mark it busy. Returns null when no funded idle account
 *  exists (→ POOL_EXHAUSTED). Funded = balanceWei >= minRelayerBalanceWei. */
export const acquireRelayerLock = internalMutation({
  args: { chainId: v.number(), minRelayerBalanceWei: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ accountIndex: number; address: string } | null> => {
    const min = BigInt(args.minRelayerBalanceWei);
    const idle = await ctx.db
      .query("relayerAccounts")
      .withIndex("by_chainId_and_busy", (q) =>
        q.eq("chainId", args.chainId).eq("busy", false),
      )
      .collect();

    const funded = idle.filter((r) => {
      try {
        return BigInt(r.balanceWei) >= min;
      } catch {
        return false;
      }
    });
    if (funded.length === 0) return null;

    // LRU: never-broadcast (undefined lastBroadcastAt) sorts first, then
    // oldest lastBroadcastAt. Tie-break by accountIndex for determinism.
    funded.sort((a, b) => {
      const la = a.lastBroadcastAt ?? 0;
      const lb = b.lastBroadcastAt ?? 0;
      if (la !== lb) return la - lb;
      return a.accountIndex - b.accountIndex;
    });

    const pick = funded[0];
    await ctx.db.patch(pick._id, { busy: true, busySince: Date.now() });
    return { accountIndex: pick.accountIndex, address: pick.address };
  },
});

/** Release after a successful broadcast: clear busy, stamp the tx, and
 *  optimistically deduct the upper-bound gas cost (gasLimit × maxFeePerGas)
 *  from the tracked balance. Always under-counts true balance — the safe
 *  drift direction; the reconcile cron corrects it. */
export const releaseRelayerLock = internalMutation({
  args: {
    chainId: v.number(),
    accountIndex: v.number(),
    txHash: v.string(),
    estCostWei: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("relayerAccounts")
      .withIndex("by_chainId_and_index", (q) =>
        q.eq("chainId", args.chainId).eq("accountIndex", args.accountIndex),
      )
      .unique();
    if (!row) return;
    let newBalance: bigint;
    try {
      newBalance = BigInt(row.balanceWei) - BigInt(args.estCostWei);
      if (newBalance < 0n) newBalance = 0n;
    } catch {
      newBalance = BigInt(row.balanceWei);
    }
    await ctx.db.patch(row._id, {
      busy: false,
      busySince: undefined,
      lastBroadcastAt: Date.now(),
      lastTxHash: args.txHash,
      balanceWei: newBalance.toString(),
      balanceUpdatedAt: Date.now(),
    });
  },
});

/** Release without touching the balance — used when we acquired a lock but
 *  did NOT broadcast (sim revert, nonce read failure, sign failure). */
export const releaseLockNoCharge = internalMutation({
  args: { chainId: v.number(), accountIndex: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("relayerAccounts")
      .withIndex("by_chainId_and_index", (q) =>
        q.eq("chainId", args.chainId).eq("accountIndex", args.accountIndex),
      )
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { busy: false, busySince: undefined });
  },
});

/** Cron: force-release accounts stuck busy past the zombie threshold —
 *  catches crashed/hung actions. Does NOT roll back any balance deduction;
 *  the reconcile cron is the source of balance truth (TRANSFERS.md §3.4). */
export const reapZombieLocks = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ reaped: number }> => {
    const cutoff = Date.now() - ZOMBIE_LOCK_MS;
    const busy = await ctx.db
      .query("relayerAccounts")
      .filter((q) => q.eq(q.field("busy"), true))
      .collect();
    let reaped = 0;
    for (const row of busy) {
      if ((row.busySince ?? 0) < cutoff) {
        await ctx.db.patch(row._id, { busy: false, busySince: undefined });
        reaped += 1;
      }
    }
    return { reaped };
  },
});

// ─── Seed + reconcile writes ───────────────────────────────────────────────

/** Idempotent upsert of one relayer account row (seed-time). Preserves
 *  busy/broadcast state on an existing row; only (re)writes address +
 *  balance. */
export const upsertRelayerAccount = internalMutation({
  args: {
    chainId: v.number(),
    accountIndex: v.number(),
    address: v.string(),
    balanceWei: v.string(),
  },
  handler: async (ctx, args) => {
    const address = lowerAddress(args.address);
    const existing = await ctx.db
      .query("relayerAccounts")
      .withIndex("by_chainId_and_index", (q) =>
        q.eq("chainId", args.chainId).eq("accountIndex", args.accountIndex),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        address,
        balanceWei: args.balanceWei,
        balanceUpdatedAt: Date.now(),
        balanceLastReconciledAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("relayerAccounts", {
      chainId: args.chainId,
      accountIndex: args.accountIndex,
      address,
      busy: false,
      balanceWei: args.balanceWei,
      balanceUpdatedAt: Date.now(),
      balanceLastReconciledAt: Date.now(),
    });
  },
});

/** Cron: overwrite a row's balance with the freshly-read on-chain value. */
export const setReconciledBalance = internalMutation({
  args: {
    chainId: v.number(),
    accountIndex: v.number(),
    balanceWei: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("relayerAccounts")
      .withIndex("by_chainId_and_index", (q) =>
        q.eq("chainId", args.chainId).eq("accountIndex", args.accountIndex),
      )
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      balanceWei: args.balanceWei,
      balanceUpdatedAt: Date.now(),
      balanceLastReconciledAt: Date.now(),
    });
  },
});

export type RelayerAccountView = {
  chainId: number;
  accountIndex: number;
  address: string;
  busy: boolean;
  lastBroadcastAt: number | null;
  lastTxHash: string | null;
  balanceWei: string;
  minRelayerBalanceWei: string;
  balanceUpdatedAt: number;
  balanceLastReconciledAt: number | null;
  lowBalance: boolean;
};

/** Public read for the /sentry gas-sponsors panel. Only sponsoring chains'
 *  accounts; everything returned is public on-chain material (no userId).
 *  `busySince` duration is deliberately NOT exposed (TRANSFERS.md §7.1). */
export const listRelayerAccounts = query({
  args: {},
  handler: async (ctx): Promise<RelayerAccountView[]> => {
    const deps = await ctx.db.query("pampaloDeployments").collect();
    const minByChain = new Map<number, string>();
    for (const d of deps) {
      if (!d.enabled || d.sponsoringTxs !== true) continue;
      const net = await ctx.db.get(d.networkId);
      if (!net) continue;
      minByChain.set(net.chainId, await resolveMinBalanceWei(ctx, d));
    }

    const rows = await ctx.db.query("relayerAccounts").collect();
    const out: RelayerAccountView[] = [];
    for (const r of rows) {
      const min = minByChain.get(r.chainId);
      if (min === undefined) continue; // chain no longer sponsoring
      let lowBalance = false;
      try {
        lowBalance = BigInt(r.balanceWei) < BigInt(min);
      } catch {
        lowBalance = false;
      }
      out.push({
        chainId: r.chainId,
        accountIndex: r.accountIndex,
        address: r.address,
        busy: r.busy,
        lastBroadcastAt: r.lastBroadcastAt ?? null,
        lastTxHash: r.lastTxHash ?? null,
        balanceWei: r.balanceWei,
        minRelayerBalanceWei: min,
        balanceUpdatedAt: r.balanceUpdatedAt,
        balanceLastReconciledAt: r.balanceLastReconciledAt ?? null,
        lowBalance,
      });
    }
    out.sort((a, b) =>
      a.chainId !== b.chainId
        ? a.chainId - b.chainId
        : a.accountIndex - b.accountIndex,
    );
    return out;
  },
});

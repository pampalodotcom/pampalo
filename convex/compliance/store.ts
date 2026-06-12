import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { lowerAddress } from "../lib/normalize";
import { resolveMinBalanceWei } from "../lib/relayerFloor";

// DB-side logic for the compliance blocklist + shield-queue screening
// (ADR 0016). The signing/broadcasting half (auto-contest) lives in
// compliance/node.ts. All writes are idempotent on (address, source).

// ─── Blocklist writes ──────────────────────────────────────────────────────

/** Idempotent upsert of one (address, source) blocklist row. */
export const _upsertBlocked = internalMutation({
  args: { address: v.string(), source: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const address = lowerAddress(args.address);
    const existing = await ctx.db
      .query("blockedAddresses")
      .withIndex("by_address_and_source", (q) =>
        q.eq("address", address).eq("source", args.source),
      )
      .unique();
    if (existing) {
      // Refresh the reason if it changed; keep addedAt stable.
      if (existing.reason !== args.reason) {
        await ctx.db.patch(existing._id, { reason: args.reason });
      }
      return existing._id;
    }
    return await ctx.db.insert("blockedAddresses", {
      address,
      source: args.source,
      reason: args.reason,
      addedAt: Date.now(),
    });
  },
});

/** Ops-facing manual add. Run from the dashboard to block an address (or to
 *  seed a test address and watch the auto-contest fire). Defaults source to
 *  "manual". */
export const addBlockedAddress = internalMutation({
  args: {
    address: v.string(),
    reason: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"blockedAddresses">> => {
    const address = lowerAddress(args.address);
    const source = args.source ?? "manual";
    const existing = await ctx.db
      .query("blockedAddresses")
      .withIndex("by_address_and_source", (q) =>
        q.eq("address", address).eq("source", source),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { reason: args.reason });
      return existing._id;
    }
    return await ctx.db.insert("blockedAddresses", {
      address,
      source,
      reason: args.reason,
      addedAt: Date.now(),
    });
  },
});

/** Remove one exact (address, source) row — used when a sanctions oracle
 *  emits SanctionedAddressesRemoved. No-op if not present. */
export const _removeBlockedExact = internalMutation({
  args: { address: v.string(), source: v.string() },
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const existing = await ctx.db
      .query("blockedAddresses")
      .withIndex("by_address_and_source", (q) =>
        q.eq("address", lowerAddress(args.address)).eq("source", args.source),
      )
      .unique();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});

// ─── Ingest cursors ────────────────────────────────────────────────────────

export const _cursorFor = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<number | null> => {
    const row = await ctx.db
      .query("complianceCursors")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    return row?.lastIndexedBlock ?? null;
  },
});

/** Monotonic cursor advance — never rolls back (re-org / replay safety). */
export const _setCursor = internalMutation({
  args: { key: v.string(), lastIndexedBlock: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("complianceCursors")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (row) {
      if (args.lastIndexedBlock > row.lastIndexedBlock) {
        await ctx.db.patch(row._id, {
          lastIndexedBlock: args.lastIndexedBlock,
        });
      }
      return row._id;
    }
    return await ctx.db.insert("complianceCursors", {
      key: args.key,
      lastIndexedBlock: args.lastIndexedBlock,
    });
  },
});

/** Ops-facing remove. Omit `source` to clear every row for the address. */
export const removeBlockedAddress = internalMutation({
  args: { address: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ removed: number }> => {
    const address = lowerAddress(args.address);
    const rows = await ctx.db
      .query("blockedAddresses")
      .withIndex("by_address", (q) => q.eq("address", address))
      .collect();
    let removed = 0;
    for (const r of rows) {
      if (args.source && r.source !== args.source) continue;
      await ctx.db.delete(r._id);
      removed += 1;
    }
    return { removed };
  },
});

// ─── Blocklist reads ───────────────────────────────────────────────────────

export type BlockMatch = { source: string; reason: string };

/** All sources flagging an address (lowercased internally). Empty = clean. */
export const _blockedFor = internalQuery({
  args: { address: v.string() },
  handler: async (ctx, args): Promise<BlockMatch[]> => {
    const rows = await ctx.db
      .query("blockedAddresses")
      .withIndex("by_address", (q) => q.eq("address", lowerAddress(args.address)))
      .collect();
    return rows.map((r) => ({ source: r.source, reason: r.reason }));
  },
});

/** Public, paginatable-enough list for a future /sentry compliance view.
 *  Public on-chain material (sanctioned-address lists are public). */
export const listBlocked = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{ address: string; source: string; reason: string; addedAt: number }>
  > => {
    const rows = await ctx.db.query("blockedAddresses").take(1000);
    return rows.map((r) => ({
      address: r.address,
      source: r.source,
      reason: r.reason,
      addedAt: r.addedAt,
    }));
  },
});

/** Per-source + total blocklist counts, for the docs / sentry surface.
 *  Caps the scan at 10k rows (a count, not a list). */
export const blockedStats = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ total: number; bySource: Record<string, number> }> => {
    const rows = await ctx.db.query("blockedAddresses").take(10_000);
    const bySource: Record<string, number> = {};
    for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    return { total: rows.length, bySource };
  },
});

// ─── Compliance signer (the Vigilant Citizen bot EOA) ────────────────────

/** Idempotent upsert of the index-5 signer row for a chain (seed-time).
 *  Preserves last-contest provenance on an existing row. */
export const upsertComplianceSigner = internalMutation({
  args: { chainId: v.number(), address: v.string(), balanceWei: v.string() },
  handler: async (ctx, args) => {
    const address = lowerAddress(args.address);
    const existing = await ctx.db
      .query("complianceSigner")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        address,
        balanceWei: args.balanceWei,
        balanceUpdatedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("complianceSigner", {
      chainId: args.chainId,
      address,
      balanceWei: args.balanceWei,
      balanceUpdatedAt: Date.now(),
    });
  },
});

export const setComplianceSignerBalance = internalMutation({
  args: { chainId: v.number(), balanceWei: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("complianceSigner")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      balanceWei: args.balanceWei,
      balanceUpdatedAt: Date.now(),
    });
  },
});

/** Stamp the latest contest tx so the panel can show "last contest …". */
export const recordContest = internalMutation({
  args: { chainId: v.number(), txHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("complianceSigner")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      lastContestTxHash: args.txHash.toLowerCase(),
      lastContestAt: Date.now(),
    });
  },
});

/** Address + RPC subdomain for one chain's signer — used by the balance
 *  reconcile (which knows the address but not the mnemonic). */
export const _complianceSignerForChain = internalQuery({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ address: string; alchemySubdomain: string } | null> => {
    const row = await ctx.db
      .query("complianceSigner")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!row) return null;
    const net = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!net) return null;
    return { address: row.address, alchemySubdomain: net.alchemySubdomain };
  },
});

export type ComplianceSignerView = {
  chainId: number;
  address: string;
  balanceWei: string;
  minBalanceWei: string;
  lowBalance: boolean;
  balanceUpdatedAt: number;
  lastContestTxHash: string | null;
  lastContestAt: number | null;
};

/** Public read for the /sentry "Vigilant Citizen bot" panel. */
export const getComplianceSigner = query({
  args: {},
  handler: async (ctx): Promise<ComplianceSignerView[]> => {
    const rows = await ctx.db.query("complianceSigner").collect();
    // Gas floor per chain = the deployment's relayer floor (same kind of
    // gas account); default "0" when absent.
    const minByChain = new Map<number, string>();
    for (const d of await ctx.db.query("pampaloDeployments").collect()) {
      const net = await ctx.db.get(d.networkId);
      if (net) minByChain.set(net.chainId, await resolveMinBalanceWei(ctx, d));
    }
    return rows.map((r) => {
      const min = minByChain.get(r.chainId) ?? "0";
      let lowBalance = false;
      try {
        lowBalance = BigInt(r.balanceWei) < BigInt(min);
      } catch {
        lowBalance = false;
      }
      return {
        chainId: r.chainId,
        address: r.address,
        balanceWei: r.balanceWei,
        minBalanceWei: min,
        lowBalance,
        balanceUpdatedAt: r.balanceUpdatedAt,
        lastContestTxHash: r.lastContestTxHash ?? null,
        lastContestAt: r.lastContestAt ?? null,
      };
    });
  },
});

// ─── Shield-queue screening source ───────────────────────────────────────

export type QueuedToScreen = {
  deploymentId: Id<"pampaloDeployments">;
  pendingId: string;
  shielder: string;
  chainId: number;
  pampalo: string;
  alchemySubdomain: string;
  unlockTime: number; // unix seconds
};

/** Still-queued shields the scan should screen, joined to their chain's
 *  router + RPC subdomain. Capped to bound per-tick work; queued shields
 *  that miss a tick are caught on the next one (the wait is much longer
 *  than the cron cadence). */
export const _queuedToScreen = internalQuery({
  args: {},
  handler: async (ctx): Promise<QueuedToScreen[]> => {
    const entries = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_state", (q) => q.eq("state", "queued"))
      .take(200);

    const depCache = new Map<
      string,
      { chainId: number; pampalo: string; alchemySubdomain: string } | null
    >();
    const out: QueuedToScreen[] = [];
    for (const e of entries) {
      const key = e.deploymentId;
      let dep = depCache.get(key);
      if (dep === undefined) {
        const d = await ctx.db.get(e.deploymentId);
        if (!d || !d.enabled || !d.pampalo) {
          dep = null;
        } else {
          const net = await ctx.db.get(d.networkId);
          dep = net
            ? {
                chainId: net.chainId,
                pampalo: d.pampalo,
                alchemySubdomain: net.alchemySubdomain,
              }
            : null;
        }
        depCache.set(key, dep);
      }
      if (!dep) continue;
      out.push({
        deploymentId: e.deploymentId,
        pendingId: e.pendingId,
        shielder: e.shielder,
        chainId: dep.chainId,
        pampalo: dep.pampalo,
        alchemySubdomain: dep.alchemySubdomain,
        unlockTime: e.unlockTime,
      });
    }
    return out;
  },
});

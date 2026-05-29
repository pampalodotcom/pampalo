import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { lowerAddress } from "../lib/normalize";

// Internal queries + mutations called by the indexer (`refresh.ts`) and
// by the public-facing queries the Sentry page renders.
//
// All writes are idempotent: re-ingesting the same event leaves the row
// in the same state. This matters because event indexers can replay logs
// on re-org or after a missed window — the indexer should never have to
// reason about "did I already see this." See SHIELD_FLOW.md §5.

// ─── Indexer-side reads ──────────────────────────────────────────────────

/** Looks up Pampalo router + chain RPC subdomain for a chainId. Used by
 *  the shieldBudget eth_call proxy and any other per-chain Pampalo
 *  read paths so they don't have to re-walk the schema themselves. */
export const _deploymentForChain = internalQuery({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ pampalo: string; alchemySubdomain: string } | null> => {
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
    };
  },
});

export type IndexerDeployment = {
  _id: Id<"pampaloDeployments">;
  pampalo: string;
  alchemySubdomain: string;
  chainId: number;
  confirmationDepth: number;
  lastIndexedBlock: number;
};

export const _enabledDeployments = internalQuery({
  args: {},
  handler: async (ctx): Promise<IndexerDeployment[]> => {
    const deployments = await ctx.db
      .query("pampaloDeployments")
      .collect();
    const out: IndexerDeployment[] = [];
    for (const d of deployments) {
      if (!d.enabled) continue;
      const network = await ctx.db.get(d.networkId);
      if (!network) continue;
      out.push({
        _id: d._id,
        pampalo: d.pampalo,
        alchemySubdomain: network.alchemySubdomain,
        chainId: network.chainId,
        confirmationDepth: d.confirmationDepth,
        lastIndexedBlock: d.lastIndexedBlock,
      });
    }
    return out;
  },
});

// ─── Indexer-side writes ─────────────────────────────────────────────────

export const _advanceCursor = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    toBlock: v.number(),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deploymentId);
    if (!d) return;
    // Monotonic-only: never roll back the cursor (defends against a
    // re-org that returns an older head temporarily).
    if (args.toBlock <= d.lastIndexedBlock) return;
    await ctx.db.patch(args.deploymentId, { lastIndexedBlock: args.toBlock });
  },
});

export const _upsertShieldQueueEntry = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    pendingId: v.string(),
    shielder: v.string(),
    asset: v.string(),
    amount: v.string(),
    leafCommitment: v.string(),
    unlockTime: v.number(),
    usdCentsCharged: v.number(),
    encryptedPayload: v.bytes(),
    queuedTxHash: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_deployment_and_pendingId", (q) =>
        q
          .eq("deploymentId", args.deploymentId)
          .eq("pendingId", args.pendingId),
      )
      .unique();
    if (existing) {
      // Already indexed; nothing to do. Replay-safety.
      return existing._id;
    }
    return await ctx.db.insert("shieldQueueEntries", {
      deploymentId: args.deploymentId,
      pendingId: args.pendingId,
      shielder: lowerAddress(args.shielder),
      asset: lowerAddress(args.asset),
      amount: args.amount,
      leafCommitment: args.leafCommitment,
      unlockTime: args.unlockTime,
      usdCentsCharged: args.usdCentsCharged,
      encryptedPayload: args.encryptedPayload,
      queuedTxHash: args.queuedTxHash.toLowerCase(),
      queuedAt: Date.now(),
      state: "queued",
    });
  },
});

export const _resolveShieldQueueEntry = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    pendingId: v.string(),
    state: v.union(
      v.literal("executed"),
      v.literal("cancelled"),
      v.literal("contested"),
    ),
    resolvedTxHash: v.string(),
    resolvedBy: v.string(),
    resolvedAt: v.number(), // unix seconds
    contestReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_deployment_and_pendingId", (q) =>
        q
          .eq("deploymentId", args.deploymentId)
          .eq("pendingId", args.pendingId),
      )
      .unique();
    if (!existing) {
      // The resolving event came in before the ShieldQueued event we'd
      // expect to insert the row. Unusual (the queue event must precede
      // resolution on chain), so log and skip — the next indexer tick
      // will see ShieldQueued first and we'll resolve in the tick after.
      console.warn(
        `_resolveShieldQueueEntry: no queue row for pendingId ${args.pendingId} on deployment ${args.deploymentId} — log out of order?`,
      );
      return;
    }
    if (existing.state !== "queued") {
      // Already resolved. Replay-safety.
      return;
    }
    await ctx.db.patch(existing._id, {
      state: args.state,
      resolvedTxHash: args.resolvedTxHash.toLowerCase(),
      resolvedBy: lowerAddress(args.resolvedBy),
      resolvedAt: args.resolvedAt,
      contestReason: args.contestReason,
    });
  },
});

export const _upsertAsset = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    tokenAddress: v.string(),
    oracle: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const tokenAddress = lowerAddress(args.tokenAddress);
    const oracle = lowerAddress(args.oracle);
    const deployment = await ctx.db.get(args.deploymentId);
    if (!deployment) return;

    const token = await ctx.db
      .query("supportedTokens")
      .withIndex("by_networkId_and_address", (q) =>
        q
          .eq("networkId", deployment.networkId)
          .eq("address", tokenAddress),
      )
      .unique();

    const existing = await ctx.db
      .query("pampaloAssets")
      .withIndex("by_deployment_and_token", (q) =>
        q
          .eq("deploymentId", args.deploymentId)
          .eq("tokenAddress", tokenAddress),
      )
      .unique();

    if (existing) {
      // Preserve the seed-supplied `assetDecimals` (the contract event
      // doesn't carry it; the seed picks it up from supportedTokens).
      // On disable, we just flip `enabled`; on re-enable, refresh oracle.
      await ctx.db.patch(existing._id, {
        oracle: args.enabled ? oracle : existing.oracle,
        enabled: args.enabled,
        lastSyncedAt: Date.now(),
      });
      return;
    }

    // First time we've seen this asset. The event doesn't give us
    // assetDecimals, so try to pull from supportedTokens (if the
    // catalogue happens to have a row), otherwise default to 18 and
    // let the seed fix it. Tracked as a known limitation.
    const assetDecimals = token?.decimals ?? 18;

    await ctx.db.insert("pampaloAssets", {
      deploymentId: args.deploymentId,
      tokenId: token?._id,
      tokenAddress,
      oracle,
      assetDecimals,
      enabled: args.enabled,
      lastSyncedAt: Date.now(),
    });
  },
});

// ─── Public queries used by the wallet + Sentry surfaces ─────────────────

/** All currently-queued shields across enabled deployments. Sentry default view. */
export const queue = query({
  args: {
    state: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("executed"),
        v.literal("cancelled"),
        v.literal("contested"),
      ),
    ),
    deploymentId: v.optional(v.id("pampaloDeployments")),
  },
  handler: async (ctx, args): Promise<Doc<"shieldQueueEntries">[]> => {
    const state = args.state ?? "queued";
    if (args.deploymentId) {
      return await ctx.db
        .query("shieldQueueEntries")
        .withIndex("by_deployment_and_state", (q) =>
          q.eq("deploymentId", args.deploymentId!).eq("state", state),
        )
        .order("desc")
        .take(200);
    }
    // Cross-deployment: scan recent rows and filter by state. For v1
    // traffic this is cheap; for scale we'd add a global-by-state index.
    return await ctx.db
      .query("shieldQueueEntries")
      .order("desc")
      .filter((q) => q.eq(q.field("state"), state))
      .take(200);
  },
});

/** Everything for one shielder. Used by the wallet's "my pending shields" view. */
export const byShielder = query({
  args: {
    shielder: v.string(), // accepts any case
  },
  handler: async (ctx, args): Promise<Doc<"shieldQueueEntries">[]> => {
    const addr = lowerAddress(args.shielder);
    return await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_shielder", (q) => q.eq("shielder", addr))
      .order("desc")
      .take(500);
  },
});

/**
 * Per-chain Pampalo deployment metadata for any enabled deployment.
 * Consumed by the wallet's shield-confirm sheet so it can resolve
 * (chainId → pampalo router address + cached wait-time + default cap)
 * without a second round-trip when the user taps Confirm.
 *
 * Public; addresses + wait + cap are all on-chain public material.
 */
export const enabledDeployments = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{
      chainId: number;
      pampaloAddress: string;
      shieldWaitSeconds: number;
      defaultMonthlyCapUsdCents: number;
    }>
  > => {
    const deployments = await ctx.db.query("pampaloDeployments").collect();
    const out: Array<{
      chainId: number;
      pampaloAddress: string;
      shieldWaitSeconds: number;
      defaultMonthlyCapUsdCents: number;
    }> = [];
    for (const d of deployments) {
      if (!d.enabled) continue;
      const net = await ctx.db.get(d.networkId);
      if (!net) continue;
      out.push({
        chainId: net.chainId,
        pampaloAddress: d.pampalo,
        shieldWaitSeconds: d.shieldWaitSeconds,
        defaultMonthlyCapUsdCents: d.defaultMonthlyCapUsdCents,
      });
    }
    return out;
  },
});

/**
 * Flat list of `(chainId, tokenAddress)` pairs that are currently
 * shieldable — used by the wallet to decide whether to render the
 * draggable slider or a static bar on each asset row. Returns only
 * pairs where both the deployment and the asset are `enabled`.
 *
 * Public; data is already public-by-design (the on-chain
 * supportedAssets mapping is readable by anyone).
 */
export const shieldablePairs = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<Array<{ chainId: number; tokenAddress: string }>> => {
    const deployments = await ctx.db.query("pampaloDeployments").collect();
    const enabledDeploys = deployments.filter((d) => d.enabled);
    if (enabledDeploys.length === 0) return [];

    // Build deploymentId -> chainId map via the FK'd supportedNetworks row.
    const chainByDeployment = new Map<Id<"pampaloDeployments">, number>();
    for (const d of enabledDeploys) {
      const net = await ctx.db.get(d.networkId);
      if (net) chainByDeployment.set(d._id, net.chainId);
    }

    const out: Array<{ chainId: number; tokenAddress: string }> = [];
    for (const [deploymentId, chainId] of chainByDeployment) {
      const assets = await ctx.db
        .query("pampaloAssets")
        .withIndex("by_deployment", (q) =>
          q.eq("deploymentId", deploymentId),
        )
        .collect();
      for (const a of assets) {
        if (!a.enabled) continue;
        out.push({ chainId, tokenAddress: a.tokenAddress });
      }
    }
    return out;
  },
});

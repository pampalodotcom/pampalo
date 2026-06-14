import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
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
  ): Promise<{
    deploymentId: Id<"pampaloDeployments">;
    pampalo: string;
    alchemySubdomain: string;
  } | null> => {
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
      deploymentId: dep._id,
      pampalo: dep.pampalo,
      alchemySubdomain: net.alchemySubdomain,
    };
  },
});

/** Idempotent upsert of one spent nullifier (deploymentId, nullifier).
 *  Written by the indexer's NullifierUsed path and the backfill action. */
export const _upsertNullifier = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    nullifier: v.string(),
    blockNumber: v.number(),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    const nullifier = args.nullifier.toLowerCase();
    const existing = await ctx.db
      .query("pampaloNullifiers")
      .withIndex("by_deployment_and_nullifier", (q) =>
        q.eq("deploymentId", args.deploymentId).eq("nullifier", nullifier),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("pampaloNullifiers", {
      deploymentId: args.deploymentId,
      nullifier,
      blockNumber: args.blockNumber,
      txHash: args.txHash.toLowerCase(),
    });
  },
});

/** The PUBLIC set of spent nullifiers for a chain's deployment, paginated.
 *  Set-download BY DESIGN: the client pulls the whole set and checks its own
 *  notes' nullifiers LOCALLY, so the server never learns which nullifiers a
 *  user holds (ADR 0019). There is deliberately NO "is this nullifier used?"
 *  endpoint — that would re-leak note ownership. */
export const usedNullifiers = query({
  args: {
    chainId: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const empty = { page: [] as string[], isDone: true, continueCursor: "" };
    const net = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!net) return empty;
    const dep = await ctx.db
      .query("pampaloDeployments")
      .withIndex("by_networkId", (q) => q.eq("networkId", net._id))
      .unique();
    if (!dep) return empty;
    const res = await ctx.db
      .query("pampaloNullifiers")
      .withIndex("by_deployment_and_block", (q) =>
        q.eq("deploymentId", dep._id),
      )
      .paginate(args.paginationOpts);
    // Explicit shape (not a spread of PaginationResult) so the client-side
    // return type is a concrete { page, isDone, continueCursor }.
    return {
      page: res.page.map((r) => r.nullifier),
      isDone: res.isDone,
      continueCursor: res.continueCursor,
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
    const deployments = await ctx.db.query("pampaloDeployments").collect();
    const out: IndexerDeployment[] = [];
    for (const d of deployments) {
      if (!d.enabled) continue;
      // Skip placeholder rows (`pampalo: ""`) — they have no contract to
      // index, and an empty `address` makes `eth_getLogs` throw
      // -32602. Mirrors the guard in the catalog query above.
      if (!d.pampalo) continue;
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
        q.eq("deploymentId", args.deploymentId).eq("pendingId", args.pendingId),
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
        q.eq("deploymentId", args.deploymentId).eq("pendingId", args.pendingId),
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

// ─── Merkle leaves (TRANSFERS.md §9.5) ───────────────────────────────────

/** Upsert a row mirroring `PoseidonMerkleTree.LeafInserted`. Idempotent
 *  on (deploymentId, epoch, leafIndex): replaying the same event leaves
 *  the row unchanged. */
export const _upsertLeaf = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    epoch: v.number(),
    leafIndex: v.number(),
    leafCommitment: v.string(),
    insertedTxHash: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pampaloLeaves")
      .withIndex("by_deployment_and_position", (q) =>
        q
          .eq("deploymentId", args.deploymentId)
          .eq("epoch", args.epoch)
          .eq("leafIndex", args.leafIndex),
      )
      .unique();
    if (existing) {
      // Replay — already indexed. Don't overwrite (insertedAt would
      // drift each replay otherwise).
      return existing._id;
    }
    return await ctx.db.insert("pampaloLeaves", {
      deploymentId: args.deploymentId,
      epoch: args.epoch,
      leafIndex: args.leafIndex,
      leafCommitment: args.leafCommitment.toLowerCase(),
      insertedTxHash: args.insertedTxHash.toLowerCase(),
      insertedAt: Date.now(),
    });
  },
});

/** Upsert a row mirroring `Pampalo.NotePayload(bytes)`. Idempotent on
 *  (deploymentId, txHash, logIndex). */
export const _upsertNotePayload = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    encryptedPayload: v.bytes(),
    txHash: v.string(),
    blockNumber: v.number(),
    logIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("transferNotes")
      .withIndex("by_deployment_and_block", (q) =>
        q
          .eq("deploymentId", args.deploymentId)
          .eq("blockNumber", args.blockNumber)
          .eq("logIndex", args.logIndex),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("transferNotes", {
      deploymentId: args.deploymentId,
      encryptedPayload: args.encryptedPayload,
      txHash: args.txHash.toLowerCase(),
      blockNumber: args.blockNumber,
      logIndex: args.logIndex,
      emittedAt: Date.now(),
    });
  },
});

// ─── Pool-activity feed (transfers + unshields) ──────────────────────────

/** Idempotent upsert of one (deploymentId, txHash) activity row. Both the
 *  NullifierUsed and NotePayload indexer paths call this for the same tx;
 *  the first creates it, later calls only fill gaps (e.g. payloadPreview
 *  from the NotePayload path). Never created for shields. */
export const _upsertActivity = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    txHash: v.string(),
    kind: v.union(v.literal("transfer"), v.literal("unshield")),
    from: v.string(),
    blockNumber: v.number(),
    blockTime: v.number(),
    payloadPreview: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const txHash = args.txHash.toLowerCase();
    const existing = await ctx.db
      .query("pampaloActivity")
      .withIndex("by_deployment_and_tx", (q) =>
        q.eq("deploymentId", args.deploymentId).eq("txHash", txHash),
      )
      .unique();
    if (existing) {
      // Only fill a missing payloadPreview; don't churn the rest on replay.
      if (args.payloadPreview && !existing.payloadPreview) {
        await ctx.db.patch(existing._id, {
          payloadPreview: args.payloadPreview,
        });
      }
      return existing._id;
    }
    return await ctx.db.insert("pampaloActivity", {
      deploymentId: args.deploymentId,
      txHash,
      kind: args.kind,
      from: lowerAddress(args.from),
      blockNumber: args.blockNumber,
      blockTime: args.blockTime,
      payloadPreview: args.payloadPreview,
    });
  },
});

export type ActivityRow = {
  txHash: string;
  chainId: number;
  kind: "transfer" | "unshield" | "shield";
  blockTime: number;
  payloadPreview: string | null;
  /** Relayer pool index when the broadcaster/finaliser is a known relayer
   *  account, else null (self-broadcast). The user's own address is
   *  deliberately not surfaced for self-broadcasts — the txHash links out. */
  relayerIndex: number | null;
  // Public deposit detail — set only for kind === "shield". A confirmed
  // deposit's asset/amount/shielder ARE public (the ShieldQueued event),
  // unlike a transfer/unshield whose interior stays hidden.
  asset?: string;
  amount?: string;
  shielder?: string;
};

/** Recent pool activity (newest first): private spends (transfer/unshield)
 *  PLUS confirmed deposits (executed shields), merged + time-sorted, with
 *  relayer attribution resolved against `relayerAccounts`. Public. */
export const recentActivity = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<ActivityRow[]> => {
    const limit = Math.min(args.limit ?? 50, 200);

    const spends = await ctx.db
      .query("pampaloActivity")
      .withIndex("by_block")
      .order("desc")
      .take(limit);
    const deposits = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_state", (q) => q.eq("state", "executed"))
      .order("desc")
      .take(limit);

    // Cached resolvers: deployment → chainId, chainId → relayer index map.
    const chainByDep = new Map<string, number | null>();
    const relayerByChain = new Map<number, Map<string, number>>();
    const resolveChain = async (
      deploymentId: Id<"pampaloDeployments">,
    ): Promise<number | null> => {
      let chainId = chainByDep.get(deploymentId);
      if (chainId === undefined) {
        const dep = await ctx.db.get(deploymentId);
        const net = dep ? await ctx.db.get(dep.networkId) : null;
        chainId = net?.chainId ?? null;
        chainByDep.set(deploymentId, chainId);
      }
      return chainId;
    };
    const resolveRelayers = async (
      chainId: number,
    ): Promise<Map<string, number>> => {
      let relayers = relayerByChain.get(chainId);
      if (!relayers) {
        const accts = await ctx.db
          .query("relayerAccounts")
          .withIndex("by_chainId_and_index", (q) => q.eq("chainId", chainId))
          .collect();
        relayers = new Map(accts.map((a) => [a.address, a.accountIndex]));
        relayerByChain.set(chainId, relayers);
      }
      return relayers;
    };

    const out: ActivityRow[] = [];

    for (const r of spends) {
      const chainId = await resolveChain(r.deploymentId);
      if (chainId === null) continue;
      const relayers = await resolveRelayers(chainId);
      out.push({
        txHash: r.txHash,
        chainId,
        kind: r.kind,
        blockTime: r.blockTime,
        payloadPreview: r.payloadPreview ?? null,
        relayerIndex: relayers.get(r.from) ?? null,
      });
    }

    for (const s of deposits) {
      const chainId = await resolveChain(s.deploymentId);
      if (chainId === null) continue;
      const relayers = await resolveRelayers(chainId);
      // Execution block time anchors the merge; fall back to first-seen.
      const blockTime = s.resolvedAt ?? Math.floor(s.queuedAt / 1000);
      out.push({
        txHash: s.resolvedTxHash ?? s.queuedTxHash,
        chainId,
        kind: "shield",
        blockTime,
        payloadPreview: null,
        relayerIndex: s.resolvedBy ? (relayers.get(s.resolvedBy) ?? null) : null,
        asset: s.asset,
        amount: s.amount,
        shielder: s.shielder,
      });
    }

    out.sort((a, b) => b.blockTime - a.blockTime);
    return out.slice(0, limit);
  },
});

/**
 * Every NotePayload on a chain. Caller (the receiver-side trial-
 * decrypt sync) walks the result and attempts ECIES decrypt on each
 * row's `encryptedPayload`. Caps at 1000 rows — at v1 Base Sepolia
 * volume this is more than enough; mainnet-scale paging is future.
 */
export const notePayloadsForChain = query({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      _id: Id<"transferNotes">;
      encryptedPayload: ArrayBuffer | string;
      txHash: string;
      blockNumber: number;
      logIndex: number;
    }>
  > => {
    const net = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!net) return [];
    const dep = await ctx.db
      .query("pampaloDeployments")
      .withIndex("by_networkId", (q) => q.eq("networkId", net._id))
      .unique();
    if (!dep) return [];

    const rows = await ctx.db
      .query("transferNotes")
      .withIndex("by_deployment_and_block", (q) =>
        q.eq("deploymentId", dep._id),
      )
      .order("asc")
      .take(1000);

    return rows.map((r) => ({
      _id: r._id,
      encryptedPayload: r.encryptedPayload,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
    }));
  },
});

/**
 * Resolve a leaf commitment to its (epoch, leafIndex) — used by the
 * receiver after a successful trial-decrypt to know where in the tree
 * the discovered note sits. Returns null when the leaf isn't (yet)
 * indexed; caller treats that as "wait for next Sync."
 */
export const leafPositionByCommitment = query({
  args: { chainId: v.number(), leafCommitment: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    epoch: number;
    leafIndex: number;
    insertedTxHash: string;
  } | null> => {
    const net = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!net) return null;
    const dep = await ctx.db
      .query("pampaloDeployments")
      .withIndex("by_networkId", (q) => q.eq("networkId", net._id))
      .unique();
    if (!dep) return null;

    const row = await ctx.db
      .query("pampaloLeaves")
      .withIndex("by_deployment_and_commitment", (q) =>
        q
          .eq("deploymentId", dep._id)
          .eq("leafCommitment", args.leafCommitment.toLowerCase()),
      )
      .unique();
    if (!row) return null;
    return {
      epoch: row.epoch,
      leafIndex: row.leafIndex,
      insertedTxHash: row.insertedTxHash,
    };
  },
});

/**
 * Every executed leaf on a deployment, in `(epoch, leafIndex)` order.
 * The client uses this to rebuild a local `PoseidonMerkleTree` mirror
 * for transfer / unshield proof generation.
 *
 * `chainId` is taken instead of a Convex `Id` so the wallet doesn't
 * need to know the deployment row id — the wallet already filters by
 * chain everywhere else.
 *
 * Caps at 2048 rows because that's the max leaves per epoch
 * (HEIGHT = 12 → MAX_LEAF_INDEX = 2^11 - 1 = 2047). v1 lives on a
 * single epoch; if/when we roll over, this query grows a pagination
 * arg and the client walks epoch-by-epoch.
 */
export const leavesForChain = query({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      epoch: number;
      leafIndex: number;
      leafCommitment: string;
      insertedTxHash: string;
    }>
  > => {
    const net = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!net) return [];
    const dep = await ctx.db
      .query("pampaloDeployments")
      .withIndex("by_networkId", (q) => q.eq("networkId", net._id))
      .unique();
    if (!dep) return [];

    const rows = await ctx.db
      .query("pampaloLeaves")
      .withIndex("by_deployment_and_position", (q) =>
        q.eq("deploymentId", dep._id),
      )
      .order("asc")
      .take(2048);

    return rows.map((r) => ({
      epoch: r.epoch,
      leafIndex: r.leafIndex,
      leafCommitment: r.leafCommitment,
      insertedTxHash: r.insertedTxHash,
    }));
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
        q.eq("networkId", deployment.networkId).eq("address", tokenAddress),
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

/**
 * Paginated shield-queue view for the public `/sentry` page. Uses
 * `usePaginatedQuery` on the client; pageSize comes from the
 * paginationOpts (the route currently passes 50). When
 * `deploymentId` is set we hit the indexed `by_deployment_and_state`
 * path; when it's null we hit the new global `by_state` index added
 * for this exact use case (SHIELD_FLOW.md §10.3).
 */
export const queue = query({
  args: {
    paginationOpts: paginationOptsValidator,
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
  handler: async (ctx, args) => {
    const state = args.state ?? "queued";
    if (args.deploymentId !== undefined) {
      const deploymentId = args.deploymentId;
      return await ctx.db
        .query("shieldQueueEntries")
        .withIndex("by_deployment_and_state", (q) =>
          q.eq("deploymentId", deploymentId).eq("state", state),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_state", (q) => q.eq("state", state))
      .order("desc")
      .paginate(args.paginationOpts);
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

// ─── Retired-deployment archive reads (ADR 0018) ────────────────────────
// Repopulate a fresh device's retired-note history. Mirror the live
// byShielder / notePayloadsForChain shapes, but read the archive tables
// keyed by the OLD deployment's (chainId, address). Retirement is derived
// client-side, so these just hand back decryptable material + the labels.

/** Retired self-shields for a shielder across all past deployments. The
 *  client trial-decrypts `encryptedPayload` with its envelope key. */
export const archivedByShielder = query({
  args: { shielder: v.string() },
  handler: async (ctx, args): Promise<Doc<"archivedShieldQueue">[]> => {
    const addr = lowerAddress(args.shielder);
    return await ctx.db
      .query("archivedShieldQueue")
      .withIndex("by_shielder", (q) => q.eq("shielder", addr))
      .order("desc")
      .take(500);
  },
});

/** Retired NotePayload ciphertexts for a chain (all past deployments).
 *  The client walks these and trial-decrypts to recover received notes. */
export const archivedNotePayloadsForChain = query({
  args: { chainId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      _id: Id<"archivedTransferNotes">;
      archivedDeploymentAddress: string;
      encryptedPayload: ArrayBuffer | string;
      txHash: string;
    }>
  > => {
    const rows = await ctx.db
      .query("archivedTransferNotes")
      .withIndex("by_chain", (q) => q.eq("chainId", args.chainId))
      .order("asc")
      .take(1000);
    return rows.map((r) => ({
      _id: r._id,
      archivedDeploymentAddress: r.archivedDeploymentAddress,
      encryptedPayload: r.encryptedPayload,
      txHash: r.txHash,
    }));
  },
});

/** Identity markers for retired deployments — the History panel uses
 *  these to label a group (`v1.x · retired <date>`) by address. */
export const listArchivedDeployments = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"archivedDeployments">[]> => {
    if (args.chainId !== undefined) {
      const chainId = args.chainId;
      return await ctx.db
        .query("archivedDeployments")
        .withIndex("by_chain", (q) => q.eq("chainId", chainId))
        .order("desc")
        .collect();
    }
    return await ctx.db.query("archivedDeployments").order("desc").collect();
  },
});

// Leaf snapshot of a retired deployment (ADR 0022). The client rebuilds the
// OLD merkle tree from these to generate a Withdraw (`unshieldBundled`) proof
// against the old contract — the live `leavesForChain` only serves the active
// deployment, and the old leaves were wiped from `pampaloLeaves` at cutover.
// Returns the full set ascending by leafIndex so the rebuilt root matches the
// old contract's final root (which is in its `isKnownRoot` window).
export const listArchivedLeaves = query({
  args: { chainId: v.number(), pampalo: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ epoch: number; leafIndex: number; leafCommitment: string }>
  > => {
    const address = lowerAddress(args.pampalo);
    const rows = await ctx.db
      .query("archivedLeaves")
      .withIndex("by_chain_and_address", (q) =>
        q.eq("chainId", args.chainId).eq("archivedDeploymentAddress", address),
      )
      .collect();
    return rows
      .map((r) => ({
        epoch: r.epoch,
        leafIndex: r.leafIndex,
        leafCommitment: r.leafCommitment,
      }))
      .sort((a, b) => a.epoch - b.epoch || a.leafIndex - b.leafIndex);
  },
});

// ─── /sentry block-explorer lookups ──────────────────────────────────────
// Cross-chain by design: each query searches every deployment and tags
// results with their chain, mirroring `byShielder`. Only PUBLIC on-chain
// material is exposed (shielder address, amounts at queue time, tx hashes,
// leaf commitments) — never the private note interior, which isn't stored.

export type ExplorerShield = {
  chainId: number;
  networkName: string;
  pendingId: string;
  shielder: string;
  asset: string;
  amount: string;
  state: string;
  unlockTime: number;
  usdCentsCharged: number;
  queuedTxHash: string;
  resolvedTxHash?: string;
  leafCommitment: string;
  queuedAt: number;
};

export type ExplorerActivity = {
  chainId: number;
  networkName: string;
  txHash: string;
  kind: string;
  from: string;
  blockNumber: number;
  blockTime: number;
};

export type ExplorerLeaf = {
  chainId: number;
  networkName: string;
  epoch: number;
  leafIndex: number;
  leafCommitment: string;
  insertedTxHash: string;
};

type ChainMeta = { chainId: number; networkName: string };

async function deploymentChainMap(
  ctx: QueryCtx,
): Promise<Map<Id<"pampaloDeployments">, ChainMeta>> {
  const deps = await ctx.db.query("pampaloDeployments").collect();
  const map = new Map<Id<"pampaloDeployments">, ChainMeta>();
  for (const d of deps) {
    const net = await ctx.db.get(d.networkId);
    if (net) map.set(d._id, { chainId: net.chainId, networkName: net.name });
  }
  return map;
}

function toExplorerShield(
  r: Doc<"shieldQueueEntries">,
  chains: Map<Id<"pampaloDeployments">, ChainMeta>,
): ExplorerShield | null {
  const meta = chains.get(r.deploymentId);
  if (!meta) return null;
  return {
    chainId: meta.chainId,
    networkName: meta.networkName,
    pendingId: r.pendingId,
    shielder: r.shielder,
    asset: r.asset,
    amount: r.amount,
    state: r.state,
    unlockTime: r.unlockTime,
    usdCentsCharged: r.usdCentsCharged,
    queuedTxHash: r.queuedTxHash,
    resolvedTxHash: r.resolvedTxHash,
    leafCommitment: r.leafCommitment,
    queuedAt: r.queuedAt,
  };
}

/** Address lookup: every shield this address has queued, newest first,
 *  enriched with chain. (Public ShieldQueued material.) */
export const lookupByAddress = query({
  args: { address: v.string() },
  handler: async (ctx, args): Promise<ExplorerShield[]> => {
    const addr = lowerAddress(args.address);
    const rows = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_shielder", (q) => q.eq("shielder", addr))
      .order("desc")
      .take(100);
    const chains = await deploymentChainMap(ctx);
    return rows
      .map((r) => toExplorerShield(r, chains))
      .filter((s): s is ExplorerShield => s !== null);
  },
});

/** Tx-hash lookup: shields queued at this tx + any pool-activity
 *  (transfer/unshield) broadcast in it, across all chains. */
export const lookupByTxHash = query({
  args: { txHash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ shields: ExplorerShield[]; activity: ExplorerActivity[] }> => {
    const tx = args.txHash.toLowerCase();
    const chains = await deploymentChainMap(ctx);

    const shieldRows = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_queuedTxHash", (q) => q.eq("queuedTxHash", tx))
      .collect();
    const shields = shieldRows
      .map((r) => toExplorerShield(r, chains))
      .filter((s): s is ExplorerShield => s !== null);

    const activity: ExplorerActivity[] = [];
    for (const [deploymentId, meta] of chains) {
      const rows = await ctx.db
        .query("pampaloActivity")
        .withIndex("by_deployment_and_tx", (q) =>
          q.eq("deploymentId", deploymentId).eq("txHash", tx),
        )
        .collect();
      for (const a of rows) {
        activity.push({
          chainId: meta.chainId,
          networkName: meta.networkName,
          txHash: a.txHash,
          kind: a.kind,
          from: a.from,
          blockNumber: a.blockNumber,
          blockTime: a.blockTime,
        });
      }
    }

    return { shields, activity };
  },
});

/** Leaf-commitment lookup: the leaf's tree position + the shield (if any)
 *  that minted it, across all chains. */
export const lookupByLeaf = query({
  args: { leafCommitment: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ leaves: ExplorerLeaf[]; shields: ExplorerShield[] }> => {
    const leaf = args.leafCommitment.toLowerCase();
    const chains = await deploymentChainMap(ctx);

    const leaves: ExplorerLeaf[] = [];
    for (const [deploymentId, meta] of chains) {
      const row = await ctx.db
        .query("pampaloLeaves")
        .withIndex("by_deployment_and_commitment", (q) =>
          q.eq("deploymentId", deploymentId).eq("leafCommitment", leaf),
        )
        .unique();
      if (row) {
        leaves.push({
          chainId: meta.chainId,
          networkName: meta.networkName,
          epoch: row.epoch,
          leafIndex: row.leafIndex,
          leafCommitment: row.leafCommitment,
          insertedTxHash: row.insertedTxHash,
        });
      }
    }

    const shieldRows = await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_leafCommitment", (q) => q.eq("leafCommitment", leaf))
      .collect();
    const shields = shieldRows
      .map((r) => toExplorerShield(r, chains))
      .filter((s): s is ExplorerShield => s !== null);

    return { leaves, shields };
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
      _id: Id<"pampaloDeployments">;
      chainId: number;
      networkName: string;
      pampaloAddress: string;
      shieldWaitSeconds: number;
      defaultMonthlyCapUsdCents: number;
      // Whether the relayer sponsors transfer/unshield on this chain.
      // Drives the client's relay-vs-self-broadcast branch. See ADR 0015.
      sponsoringTxs: boolean;
    }>
  > => {
    const deployments = await ctx.db.query("pampaloDeployments").collect();
    const out: Array<{
      _id: Id<"pampaloDeployments">;
      chainId: number;
      networkName: string;
      pampaloAddress: string;
      shieldWaitSeconds: number;
      defaultMonthlyCapUsdCents: number;
      sponsoringTxs: boolean;
    }> = [];
    for (const d of deployments) {
      if (!d.enabled) continue;
      // Skip "addresses-only" placeholder rows (forward-declared
      // mainnet deployments that don't have a live Pampalo contract
      // yet). Live-contract callers — shield/transfer flows — must
      // never see these.
      if (!d.pampalo) continue;
      const net = await ctx.db.get(d.networkId);
      if (!net) continue;
      out.push({
        _id: d._id,
        chainId: net.chainId,
        networkName: net.name,
        pampaloAddress: d.pampalo,
        shieldWaitSeconds: d.shieldWaitSeconds,
        defaultMonthlyCapUsdCents: d.defaultMonthlyCapUsdCents,
        sponsoringTxs: d.sponsoringTxs ?? false,
      });
    }
    return out;
  },
});

/**
 * One-shot seed: ensures every Pampalo deployment row has
 * `separateDerivationKey` populated, flips Base Sepolia to false, and
 * inserts addresses-only placeholder rows for Ethereum + Base mainnet.
 *
 * Idempotent — safe to run multiple times. Run from the Convex
 * dashboard once after this commit lands.
 */
export const seedSeparateDerivationKeys = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result: {
      patched: number;
      placeholdersCreated: number;
      placeholdersSkipped: number;
      missingNetworks: number[];
    } = {
      patched: 0,
      placeholdersCreated: 0,
      placeholdersSkipped: 0,
      missingNetworks: [],
    };

    // Step 1: backfill the flag on every existing deployment. Base
    // Sepolia (84532) → false (preserves today's path-0 envelope so
    // existing notes still decrypt). Everything else → true.
    const existing = await ctx.db.query("pampaloDeployments").collect();
    for (const d of existing) {
      const net = await ctx.db.get(d.networkId);
      const desired = net?.chainId === 84532 ? false : true;
      if (d.separateDerivationKey === desired) continue;
      await ctx.db.patch(d._id, { separateDerivationKey: desired });
      result.patched += 1;
    }

    // Step 2: seed Ethereum + Base mainnet placeholder rows so the
    // Receive picker can show them ahead of a real Pampalo deployment.
    // `pampalo: ""` is the placeholder sentinel — enabledDeployments
    // (used by shield/transfer flows) filters these out.
    const mainnetChainIds = [1, 8453];
    const existingByChainId = new Map<number, true>();
    for (const d of existing) {
      const net = await ctx.db.get(d.networkId);
      if (net) existingByChainId.set(net.chainId, true);
    }
    for (const chainId of mainnetChainIds) {
      if (existingByChainId.has(chainId)) {
        result.placeholdersSkipped += 1;
        continue;
      }
      const net = await ctx.db
        .query("supportedNetworks")
        .withIndex("by_chainId", (q) => q.eq("chainId", chainId))
        .first();
      if (!net) {
        result.missingNetworks.push(chainId);
        continue;
      }
      await ctx.db.insert("pampaloDeployments", {
        networkId: net._id,
        pampalo: "",
        poseidon2Huff: "",
        verifiers: {
          deposit: "",
          transfer: "",
          withdraw: "",
          transferExternal: "",
        },
        shieldWaitSeconds: 0,
        defaultMonthlyCapUsdCents: 0,
        confirmationDepth: 1,
        lastIndexedBlock: 0,
        enabled: true,
        separateDerivationKey: true,
      });
      result.placeholdersCreated += 1;
    }

    return result;
  },
});

/**
 * Like `enabledDeployments`, but ALSO returns "addresses-only"
 * placeholder rows where `pampalo` is empty. Surfaces the
 * `separateDerivationKey` flag so the Receive picker can pick the
 * right envelope key (path-0 shared vs slot-420 isolated) per network.
 *
 * Forward-declared mainnet rows live here so a user can share their
 * Pampalo identity on Ethereum / Base mainnet before the contract
 * ships there — addresses are stable from the moment the row exists.
 *
 * Public; addresses and flags are public material.
 */
export const receivableDeployments = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{
      _id: Id<"pampaloDeployments">;
      chainId: number;
      networkName: string;
      /** Empty string when the deployment is a placeholder (no live
       *  Pampalo contract yet). Receive UI surfaces this distinction. */
      pampaloAddress: string;
      separateDerivationKey: boolean;
    }>
  > => {
    const deployments = await ctx.db.query("pampaloDeployments").collect();
    const out: Array<{
      _id: Id<"pampaloDeployments">;
      chainId: number;
      networkName: string;
      pampaloAddress: string;
      separateDerivationKey: boolean;
    }> = [];
    for (const d of deployments) {
      if (!d.enabled) continue;
      const net = await ctx.db.get(d.networkId);
      if (!net) continue;
      out.push({
        _id: d._id,
        chainId: net.chainId,
        networkName: net.name,
        pampaloAddress: d.pampalo,
        // Undefined treated as true (the new default) — see schema.
        separateDerivationKey: d.separateDerivationKey ?? true,
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
        .withIndex("by_deployment", (q) => q.eq("deploymentId", deploymentId))
        .collect();
      for (const a of assets) {
        if (!a.enabled) continue;
        out.push({ chainId, tokenAddress: a.tokenAddress });
      }
    }
    return out;
  },
});

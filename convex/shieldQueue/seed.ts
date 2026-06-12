import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import { lowerAddress } from "../lib/normalize";
import { ETH_ADDRESS } from "../catalog/seed";

// Delete every indexed child row tied to a deployment — used when a
// redeploy abandons the old contract (ADR 0017). Returns per-table counts.
// Testnet-scale only; a high-volume deployment would need batched deletes.
async function wipeDeploymentChildren(
  ctx: MutationCtx,
  deploymentId: Id<"pampaloDeployments">,
): Promise<{ leaves: number; queue: number; notes: number; activity: number }> {
  const del = async (
    rows: Array<{ _id: Id<"pampaloLeaves" | "shieldQueueEntries" | "transferNotes" | "pampaloActivity"> }>,
  ) => {
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  };
  const leaves = await del(
    await ctx.db
      .query("pampaloLeaves")
      .withIndex("by_deployment", (q) => q.eq("deploymentId", deploymentId))
      .collect(),
  );
  const queue = await del(
    await ctx.db
      .query("shieldQueueEntries")
      .withIndex("by_deployment_and_state", (q) =>
        q.eq("deploymentId", deploymentId),
      )
      .collect(),
  );
  const notes = await del(
    await ctx.db
      .query("transferNotes")
      .withIndex("by_deployment", (q) => q.eq("deploymentId", deploymentId))
      .collect(),
  );
  const activity = await del(
    await ctx.db
      .query("pampaloActivity")
      .withIndex("by_deployment_and_tx", (q) =>
        q.eq("deploymentId", deploymentId),
      )
      .collect(),
  );
  return { leaves, queue, notes, activity };
}

// Copy the user-recoverable rows of a soon-to-be-wiped deployment into the
// archive tables (ADR 0018) so a user's pre-redeploy notes survive
// cross-device as read-only history. MUST run BEFORE wipeDeploymentChildren
// and BEFORE the deployment row is replaced (we need the OLD address). Only
// shieldQueueEntries (self-shields) + transferNotes (received notes) carry
// envelope-decryptable material; leaves/activity are positional/public and
// intentionally not archived. Testnet-scale only (collect-then-insert).
async function archiveDeploymentChildren(
  ctx: MutationCtx,
  deploymentId: Id<"pampaloDeployments">,
  chainId: number,
  oldPampalo: string,
  version: string | undefined,
): Promise<{ shields: number; notes: number }> {
  const archivedDeploymentAddress = lowerAddress(oldPampalo);
  const now = Date.now();

  const queue = await ctx.db
    .query("shieldQueueEntries")
    .withIndex("by_deployment_and_state", (q) =>
      q.eq("deploymentId", deploymentId),
    )
    .collect();
  for (const r of queue) {
    await ctx.db.insert("archivedShieldQueue", {
      chainId,
      archivedDeploymentAddress,
      shielder: r.shielder,
      asset: r.asset,
      amount: r.amount,
      leafCommitment: r.leafCommitment,
      encryptedPayload: r.encryptedPayload,
      state: r.state,
      unlockTime: r.unlockTime,
      queuedTxHash: r.queuedTxHash,
      queuedAt: r.queuedAt,
    });
  }

  const notes = await ctx.db
    .query("transferNotes")
    .withIndex("by_deployment", (q) => q.eq("deploymentId", deploymentId))
    .collect();
  for (const r of notes) {
    await ctx.db.insert("archivedTransferNotes", {
      chainId,
      archivedDeploymentAddress,
      encryptedPayload: r.encryptedPayload,
      txHash: r.txHash,
      emittedAt: r.emittedAt,
    });
  }

  // Identity marker — one row per retired deployment (idempotent on
  // (chainId, address), so a re-seed doesn't duplicate it).
  const existingMarker = await ctx.db
    .query("archivedDeployments")
    .withIndex("by_chain_and_address", (q) =>
      q.eq("chainId", chainId).eq("pampalo", archivedDeploymentAddress),
    )
    .unique();
  if (!existingMarker) {
    await ctx.db.insert("archivedDeployments", {
      chainId,
      pampalo: archivedDeploymentAddress,
      version,
      retiredAt: now,
    });
  }

  return { shields: queue.length, notes: notes.length };
}

// Gas-sponsoring defaults (TRANSFERS.md §2.4). Base Sepolia is the only
// chain sponsoring at seed time; flipping another chain on is a manual
// operator change. The min-balance floor is per-chain (gas prices vary).
const BASE_SEPOLIA_CHAIN_ID = 84532;
const DEFAULT_MIN_RELAYER_BALANCE_WEI = "10000000000000000"; // 0.01 ETH

// Dashboard / CLI-only seed for the Pampalo deployment catalogue. Run:
//   pnpm convex run shieldQueue/seed:seedAll
//
// Idempotent — re-running upserts the `pampaloDeployments` row and any
// `pampaloAssets` rows that already exist (so a re-seed after a contract
// redeploy refreshes addresses without wiping queue history). Queue
// entries themselves live in `shieldQueueEntries`, populated by the
// event indexer (`convex/shieldQueue/refresh.ts` — landing next).
//
// Source of truth for what to seed: contracts/deployments/<chainId>.json
// produced by `pnpm --filter @pampalo/contracts deploy:base-sepolia`.
// Addresses below mirror that file at the v1 Base Sepolia deployment;
// update on every contract redeploy.

type SeedDeployment = {
  chainId: number;
  pampalo: string;
  poseidon2Huff: string;
  verifiers: {
    deposit: string;
    transfer: string;
    withdraw: string;
    transferExternal: string;
  };
  shieldWaitSeconds: number;
  defaultMonthlyCapUsdCents: number;
  confirmationDepth: number;
  // Block the Pampalo contract was deployed at — the indexer's cold-start
  // cursor. REQUIRED for mainnet: without it a fresh/placeholder row starts
  // at 0 and the indexer scans the chain from genesis. Mirrors
  // sdk/src/deployments.ts `fromBlock`.
  fromBlock?: number;
  // Whether the relayer pool sponsors transfer/unshield on this chain
  // (ADR 0015). Defaults to Base Sepolia only when omitted; set explicitly
  // to turn another chain's sponsoring on at seed time. Preserved across
  // re-seeds (an operator's later manual flip is never clobbered).
  sponsoringTxs?: boolean;
  assets: Array<{
    tokenAddress: string;
    oracle: string;
    assetDecimals: number;
  }>;
};

// v1 Base Sepolia. Addresses verbatim from contracts/deployments/84532.json
// (deployment timestamp 2026-05-29T02:10:52.365Z).
const DEPLOYMENTS: SeedDeployment[] = [
  {
    chainId: 84532,
    // v2.0.0 — deployed 2026-06-12 from index-1 (0x77c2…f054). See
    // contracts/deployments/84532.json + DEPLOYMENT.md ledger.
    pampalo: "0x86cC802B2d5a9EF41194E68ed69EeCC37AdAAf59",
    poseidon2Huff: "0x55edf41867bA8F18f68c2E42614465f86C35AE4E",
    verifiers: {
      deposit: "0x04D2D2B7D4345714D0451D4446E5C2dca049Ce33",
      transfer: "0xEDE22DBb1C48FAb78079924e60038b0E74c51357",
      withdraw: "0x09e3f6f4A67F5C8818c634137AeA181acCa392A3",
      transferExternal: "0x98f54Fb3fB1BA577344aFfd9222B5100aCB35e1D",
    },
    // Mirror the on-chain constants — re-read by the catalog-refresh
    // cron once that lands. Tightening these doesn't break anything;
    // they're display caches, not enforcement.
    shieldWaitSeconds: 3600,
    defaultMonthlyCapUsdCents: 200_00, // $200.00 (display cache; chain enforces)
    // Base Sepolia is fast-finality; 5 blocks ≈ 10s of trail.
    confirmationDepth: 5,
    fromBlock: 42746800, // v2 deploy block (mirrors sdk/src/deployments.ts)
    assets: [
      {
        // Native ETH sentinel — matches the Pampalo contract's ETH_ADDRESS.
        tokenAddress: ETH_ADDRESS,
        oracle: "0x84A490A5f77C202aa89687c9105f8cf0e7485bE9",
        assetDecimals: 18,
      },
      {
        // USDC mock — respins with every deploy. Update alongside the
        // address in catalog/seed.ts TOKENS.
        tokenAddress: "0x445b24Cf4Ac9AC20ecc417Ac41160Fdc8088520d",
        oracle: "0xF1bCFbb62F3337295C2f33CCe0662574F4687b2A",
        assetDecimals: 6,
      },
    ],
  },
  {
    // Base mainnet (8453). Same contract addresses as Base Sepolia
    // (deployed from the index-1 nonce-0 deployer for cross-chain parity —
    // DEPLOYMENT.md ledger). Verbatim from contracts/deployments/8453.json.
    chainId: 8453,
    pampalo: "0x86cC802B2d5a9EF41194E68ed69EeCC37AdAAf59",
    poseidon2Huff: "0x55edf41867bA8F18f68c2E42614465f86C35AE4E",
    verifiers: {
      deposit: "0x04D2D2B7D4345714D0451D4446E5C2dca049Ce33",
      transfer: "0xEDE22DBb1C48FAb78079924e60038b0E74c51357",
      withdraw: "0x09e3f6f4A67F5C8818c634137AeA181acCa392A3",
      transferExternal: "0x98f54Fb3fB1BA577344aFfd9222B5100aCB35e1D",
    },
    shieldWaitSeconds: 3600,
    defaultMonthlyCapUsdCents: 200_00, // $200.00 (display cache; chain enforces)
    // Base mainnet has a single sequencer; 5 blocks (~10s) of trail is
    // ample. Bump if you ever want more reorg headroom for real value.
    confirmationDepth: 5,
    fromBlock: 47237162, // deploy block (mirrors sdk/src/deployments.ts)
    // Turn relayer sponsoring on for mainnet at seed time.
    sponsoringTxs: true,
    assets: [
      {
        // Native ETH sentinel.
        tokenAddress: ETH_ADDRESS,
        oracle: "0x84A490A5f77C202aa89687c9105f8cf0e7485bE9",
        assetDecimals: 18,
      },
      {
        // Real Circle-issued USDC on Base (NOT the mock). Must be
        // registered on the Pampalo contract on-chain first —
        // scripts/add-base-usdc.ts. Oracle wraps Base's Chainlink
        // USDC/USD feed, so it prices real USDC correctly.
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        oracle: "0xF1bCFbb62F3337295C2f33CCe0662574F4687b2A",
        assetDecimals: 6,
      },
    ],
  },
];

export const addDeployment = internalMutation({
  args: {
    chainId: v.number(),
    pampalo: v.string(),
    poseidon2Huff: v.string(),
    verifiers: v.object({
      deposit: v.string(),
      transfer: v.string(),
      withdraw: v.string(),
      transferExternal: v.string(),
    }),
    shieldWaitSeconds: v.number(),
    defaultMonthlyCapUsdCents: v.number(),
    confirmationDepth: v.number(),
    // Optional; defaults to 0 if absent. Set when re-seeding for a
    // redeploy so the indexer doesn't redundantly scan pre-deploy blocks.
    lastIndexedBlock: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const network = await ctx.db
      .query("supportedNetworks")
      .withIndex("by_chainId", (q) => q.eq("chainId", args.chainId))
      .unique();
    if (!network) {
      throw new Error(
        `No supportedNetworks row for chainId ${args.chainId}. Run catalog/seed:seedAll first.`,
      );
    }
    const existing = await ctx.db
      .query("pampaloDeployments")
      .withIndex("by_networkId", (q) => q.eq("networkId", network._id))
      .unique();
    const payload = {
      networkId: network._id,
      pampalo: lowerAddress(args.pampalo),
      poseidon2Huff: lowerAddress(args.poseidon2Huff),
      verifiers: {
        deposit: lowerAddress(args.verifiers.deposit),
        transfer: lowerAddress(args.verifiers.transfer),
        withdraw: lowerAddress(args.verifiers.withdraw),
        transferExternal: lowerAddress(args.verifiers.transferExternal),
      },
      shieldWaitSeconds: args.shieldWaitSeconds,
      defaultMonthlyCapUsdCents: args.defaultMonthlyCapUsdCents,
      confirmationDepth: args.confirmationDepth,
      // Preserve existing cursor on re-seed; default to 0 for new rows.
      lastIndexedBlock:
        existing?.lastIndexedBlock ?? args.lastIndexedBlock ?? 0,
      enabled: args.enabled ?? true,
      // Preserve sponsoring config across a full replace; default per chain.
      sponsoringTxs:
        existing?.sponsoringTxs ?? args.chainId === BASE_SEPOLIA_CHAIN_ID,
      minRelayerBalanceWei:
        existing?.minRelayerBalanceWei ?? DEFAULT_MIN_RELAYER_BALANCE_WEI,
    };
    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("pampaloDeployments", payload);
  },
});

export const addAsset = internalMutation({
  args: {
    deploymentId: v.id("pampaloDeployments"),
    tokenAddress: v.string(),
    oracle: v.string(),
    assetDecimals: v.number(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const tokenAddress = lowerAddress(args.tokenAddress);
    const oracle = lowerAddress(args.oracle);

    // Match to a supportedTokens row when one exists, but don't fail
    // if not — test-network mocks may pre-date their catalogue entry.
    const deployment = await ctx.db.get(args.deploymentId);
    if (!deployment) {
      throw new Error(`pampaloDeployments id ${args.deploymentId} not found`);
    }
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

    const payload = {
      deploymentId: args.deploymentId,
      tokenId: token?._id,
      tokenAddress,
      oracle,
      assetDecimals: args.assetDecimals,
      enabled: args.enabled ?? true,
      lastSyncedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.replace(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("pampaloAssets", payload);
  },
});

export const seedAll = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    deployments: number;
    assets: number;
    chains: Array<{ chainId: number; action: string }>;
    missingNetworks: number[];
  }> => {
    let assetCount = 0;
    const deploymentIds: Array<Id<"pampaloDeployments">> = [];
    // Per-chain outcome so "did 8453 land?" is answerable from the result,
    // and missing-network skips are surfaced instead of aborting the run.
    const chains: Array<{ chainId: number; action: string }> = [];
    const missingNetworks: number[] = [];

    for (const d of DEPLOYMENTS) {
      const network = await ctx.db
        .query("supportedNetworks")
        .withIndex("by_chainId", (q) => q.eq("chainId", d.chainId))
        .unique();
      if (!network) {
        // Skip this chain rather than throwing half-done — the earlier
        // chains in the loop have already been upserted, and aborting here
        // would leave the operator guessing what landed. Report it instead.
        console.warn(
          `[seed] no supportedNetworks row for chainId ${d.chainId} — ` +
            `skipped. Run catalog/seed:seedAll first, then re-run.`,
        );
        missingNetworks.push(d.chainId);
        continue;
      }

      const existing = await ctx.db
        .query("pampaloDeployments")
        .withIndex("by_networkId", (q) => q.eq("networkId", network._id))
        .unique();

      // A changed Pampalo address means a clean-break redeploy (no proxy,
      // fresh tree). The old contract's indexed children are now orphaned —
      // and `pampaloLeaves` would COLLIDE on (epoch,leafIndex) with the new
      // tree (both restart at 0,0), corrupting the client's tree mirror and
      // breaking proofs. So wipe them + reset the cursor. See ADR 0017.
      //
      // Guard against `existing.pampalo === ""`: a forward-declared
      // placeholder row being populated with real addresses for the first
      // time is an *initial* seed, not a redeploy — there are no children
      // to archive/wipe and no stale tree to reset.
      const addressChanged =
        !!existing &&
        existing.pampalo !== "" &&
        existing.pampalo !== lowerAddress(d.pampalo);

      const action = !existing
        ? "created"
        : addressChanged
          ? "redeployed"
          : "updated";

      const deploymentPayload = {
        networkId: network._id,
        pampalo: lowerAddress(d.pampalo),
        poseidon2Huff: lowerAddress(d.poseidon2Huff),
        verifiers: {
          deposit: lowerAddress(d.verifiers.deposit),
          transfer: lowerAddress(d.verifiers.transfer),
          withdraw: lowerAddress(d.verifiers.withdraw),
          transferExternal: lowerAddress(d.verifiers.transferExternal),
        },
        shieldWaitSeconds: d.shieldWaitSeconds,
        defaultMonthlyCapUsdCents: d.defaultMonthlyCapUsdCents,
        confirmationDepth: d.confirmationDepth,
        // Cursor handling:
        //   • redeploy        → cold-start from the new deploy block
        //   • live row (>0)    → preserve the indexer's progress
        //   • placeholder/new  → start at the deploy block, NEVER 0 (else
        //                        the indexer scans the chain from genesis)
        lastIndexedBlock: addressChanged
          ? (d.fromBlock ?? 0)
          : existing && existing.lastIndexedBlock > 0
            ? existing.lastIndexedBlock
            : (d.fromBlock ?? 0),
        enabled: true,
        // Preserve an operator's manual sponsoring flip on re-seed; else
        // take the seed entry's explicit value; else default to Base
        // Sepolia only. relayerAccounts rows are seeded separately via
        // relayer/node:seedRelayerAccounts.
        sponsoringTxs:
          existing?.sponsoringTxs ??
          d.sponsoringTxs ??
          d.chainId === BASE_SEPOLIA_CHAIN_ID,
        minRelayerBalanceWei:
          existing?.minRelayerBalanceWei ?? DEFAULT_MIN_RELAYER_BALANCE_WEI,
      };

      let deploymentId: Id<"pampaloDeployments">;
      if (existing) {
        // Capture the OLD address before replace overwrites the row.
        const oldPampalo = existing.pampalo;
        await ctx.db.replace(existing._id, deploymentPayload);
        deploymentId = existing._id;
        if (addressChanged) {
          // Archive the user-recoverable rows BEFORE wiping (ADR 0018), so
          // retired notes survive cross-device. Child rows are still keyed
          // by the (reused) deploymentId, so they read fine post-replace.
          const archived = await archiveDeploymentChildren(
            ctx,
            deploymentId,
            d.chainId,
            oldPampalo,
            undefined, // on-chain VERSION not known server-side
          );
          const wiped = await wipeDeploymentChildren(ctx, deploymentId);
          console.warn(
            `[seed] redeploy on chain ${d.chainId}: archived ` +
              `(${archived.shields} shields, ${archived.notes} notes) from ` +
              `${oldPampalo} then wiped orphaned rows (${wiped.leaves} leaves, ` +
              `${wiped.queue} queue, ${wiped.notes} notes, ` +
              `${wiped.activity} activity) + reset cursor.`,
          );
        }
      } else {
        deploymentId = await ctx.db.insert(
          "pampaloDeployments",
          deploymentPayload,
        );
      }
      deploymentIds.push(deploymentId);
      chains.push({ chainId: d.chainId, action });

      // Assets — one upsert per declared asset.
      for (const a of d.assets) {
        const tokenAddress = lowerAddress(a.tokenAddress);
        const oracle = lowerAddress(a.oracle);
        const token = await ctx.db
          .query("supportedTokens")
          .withIndex("by_networkId_and_address", (q) =>
            q.eq("networkId", network._id).eq("address", tokenAddress),
          )
          .unique();

        const existingAsset = await ctx.db
          .query("pampaloAssets")
          .withIndex("by_deployment_and_token", (q) =>
            q.eq("deploymentId", deploymentId).eq("tokenAddress", tokenAddress),
          )
          .unique();

        const assetPayload = {
          deploymentId,
          tokenId: token?._id,
          tokenAddress,
          oracle,
          assetDecimals: a.assetDecimals,
          enabled: true,
          lastSyncedAt: Date.now(),
        };

        if (existingAsset) {
          await ctx.db.replace(existingAsset._id, assetPayload);
        } else {
          await ctx.db.insert("pampaloAssets", assetPayload);
        }
        assetCount += 1;
      }
    }

    return {
      deployments: deploymentIds.length,
      assets: assetCount,
      chains,
      missingNetworks,
    };
  },
});

// One command that seeds in the correct order — catalog (networks +
// tokens + price feeds) THEN the Pampalo deployment catalogue — so the
// "run catalog first or shieldQueue throws / skips" footgun disappears.
// Run:  npx convex run shieldQueue/seed:seedEverything
export const seedEverything = internalAction({
  args: {},
  // Explicit return type required: the handler references this module's own
  // `seedAll` via `runMutation`, so inference would be circular.
  handler: async (
    ctx,
  ): Promise<{
    catalog: {
      networks: number;
      priceFeeds: number;
      tokens: number;
      tokensPruned: number;
      uniswapPools: number;
    };
    deployments: {
      deployments: number;
      assets: number;
      chains: Array<{ chainId: number; action: string }>;
      missingNetworks: number[];
    };
  }> => {
    const catalog = await ctx.runMutation(internal.catalog.seed.seedAll, {});
    const deployments = await ctx.runMutation(
      internal.shieldQueue.seed.seedAll,
      {},
    );
    if (deployments.missingNetworks.length > 0) {
      console.warn(
        `[seed] deployments still missing networks: ${deployments.missingNetworks.join(", ")}`,
      );
    }
    return { catalog, deployments };
  },
});

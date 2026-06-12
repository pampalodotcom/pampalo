import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { lowerAddress } from "../lib/normalize";
import { ETH_ADDRESS } from "../catalog/seed";

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
    pampalo: "0x3E6dfc4c233486A44e26A548e191c839f069037f",
    poseidon2Huff: "0x090Fd81205Da513803a78FB2628f032385564998",
    verifiers: {
      deposit: "0xB656b7358c9Ef0CccC698405cFb090C854BC8460",
      transfer: "0x819CDE597613a12FCF2Ce8fc3fCAF25dfF585B71",
      withdraw: "0xA6C469Ceba94A8549a0692b85b68390549D23Bd7",
      transferExternal: "0xc729DfAAde6e9deE6BA95A04772d27bf45EcdDBD",
    },
    // Mirror the on-chain constants — re-read by the catalog-refresh
    // cron once that lands. Tightening these doesn't break anything;
    // they're display caches, not enforcement.
    shieldWaitSeconds: 3600,
    defaultMonthlyCapUsdCents: 200_00, // $200.00 (display cache; chain enforces)
    // Base Sepolia is fast-finality; 5 blocks ≈ 10s of trail.
    confirmationDepth: 5,
    assets: [
      {
        // Native ETH sentinel — matches the Pampalo contract's ETH_ADDRESS.
        tokenAddress: ETH_ADDRESS,
        oracle: "0x6aCC11a076eAE4236d734E2050E568B375944AB8",
        assetDecimals: 18,
      },
      {
        // USDC mock — respins with every deploy. Update alongside the
        // address in catalog/seed.ts TOKENS.
        tokenAddress: "0x4Fc9cc04f2A8d6Ff360352C61A4bb36Ab262Ae01",
        oracle: "0x1d787703FAAF8677Ac43784d6eC7875127f8BFF9",
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
  }> => {
    let assetCount = 0;
    const deploymentIds: Array<Id<"pampaloDeployments">> = [];

    for (const d of DEPLOYMENTS) {
      const network = await ctx.db
        .query("supportedNetworks")
        .withIndex("by_chainId", (q) => q.eq("chainId", d.chainId))
        .unique();
      if (!network) {
        throw new Error(
          `No supportedNetworks row for chainId ${d.chainId}. Run catalog/seed:seedAll first.`,
        );
      }

      const existing = await ctx.db
        .query("pampaloDeployments")
        .withIndex("by_networkId", (q) => q.eq("networkId", network._id))
        .unique();

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
        // Preserve cursor on re-seed; fresh rows start at 0.
        lastIndexedBlock: existing?.lastIndexedBlock ?? 0,
        enabled: true,
        // Preserve an operator's manual sponsoring flip on re-seed; default
        // to on only for Base Sepolia. relayerAccounts rows are seeded
        // separately via relayer/node:seedRelayerAccounts.
        sponsoringTxs:
          existing?.sponsoringTxs ?? d.chainId === BASE_SEPOLIA_CHAIN_ID,
        minRelayerBalanceWei:
          existing?.minRelayerBalanceWei ?? DEFAULT_MIN_RELAYER_BALANCE_WEI,
      };

      let deploymentId: Id<"pampaloDeployments">;
      if (existing) {
        await ctx.db.replace(existing._id, deploymentPayload);
        deploymentId = existing._id;
      } else {
        deploymentId = await ctx.db.insert(
          "pampaloDeployments",
          deploymentPayload,
        );
      }
      deploymentIds.push(deploymentId);

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

    return { deployments: deploymentIds.length, assets: assetCount };
  },
});

import { ContractFactory } from "ethers";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import hre from "hardhat";

import PampaloSwapV3Module from "@/ignition/modules/PampaloSwapV3.js";
import PampaloSwapV4Module from "@/ignition/modules/PampaloSwapV4.js";
import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// Full deployment of the private-swap venue contracts (PampaloSwapV3 /
// PampaloSwapV4) onto a public network with REAL Uniswap liquidity. Each
// contract is a superset of Pampalo (ADR 0017 clean-break: deploy instead
// of Pampalo, not alongside). Unlike scripts/deploy.ts this does NOT
// deploy a USDC mock — it registers the chain's real USDC + WETH (+ ETH)
// as supported assets against Chainlink oracles.
//
// Which venues to deploy is driven by SWAP_VENUES ("v3", "v4", or
// "v3,v4"; default both).
//
// Usage:
//   SWAP_VENUES=v3,v4 hardhat run scripts/deploy-swap.ts --network base

const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const STEP_SLEEP_MS = 3000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Per-chain real-token + venue + Chainlink-feed config. WETH reuses the
// ETH/USD feed (WETH tracks ETH 1:1 for oracle purposes).
type ChainConfig = {
  usdc: string;
  weth: string;
  v3Router: string;
  v4PoolManager: string;
  feeds: {
    eth: { feed: string; maxAge: number };
    usdc: { feed: string; maxAge: number };
  };
};

const CHAINS: Record<number, ChainConfig> = {
  // Base mainnet
  8453: {
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    weth: "0x4200000000000000000000000000000000000006",
    v3Router: "0x2626664c2603336e57b271c5c0b26f421741e481", // SwapRouter02
    v4PoolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    feeds: {
      eth: { feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", maxAge: 7200 },
      usdc: {
        feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
        maxAge: 172800,
      },
    },
  },
};

async function deployVenue(args: {
  connection: Awaited<ReturnType<typeof hre.network.connect>>;
  venue: "v3" | "v4";
  cfg: ChainConfig;
  chainId: number;
  deployer: Awaited<
    ReturnType<Awaited<ReturnType<typeof hre.network.connect>>["ethers"]["getSigners"]>
  >[number];
}): Promise<Record<string, unknown>> {
  const { connection, venue, cfg, chainId, deployer } = args;

  console.log(`\n=== Deploying Pampalo${venue.toUpperCase()} ===`);

  const venueAddr = venue === "v3" ? cfg.v3Router : cfg.v4PoolManager;
  const result =
    venue === "v3"
      ? await connection.ignition.deploy(PampaloSwapV3Module, {
          parameters: { pampaloSwapV3: { swapRouter: venueAddr } },
        })
      : await connection.ignition.deploy(PampaloSwapV4Module, {
          parameters: { pampaloSwapV4: { poolManager: venueAddr } },
        });

  const pampalo = result.pampalo;
  const pampaloAddress = await pampalo.getAddress();
  console.log(`  Pampalo${venue.toUpperCase()} : ${pampaloAddress}`);
  console.log(`  venue (${venue})       : ${venueAddr}`);
  await sleep(STEP_SLEEP_MS);

  // Poseidon hasher.
  const existingHasher = await pampalo.poseidon2Hasher();
  let poseidon2HuffAddress: string;
  if (existingHasher !== "0x0000000000000000000000000000000000000000") {
    poseidon2HuffAddress = existingHasher;
    console.log(`  Poseidon already set: ${existingHasher}`);
  } else {
    // Explicit gasLimits on every direct tx so hardhat-ethers skips
    // eth_estimateGas — the Base sequencer RPC (used for deploys to dodge
    // Alchemy's nonce-read lag) has a flaky estimateGas that spuriously
    // reverts on CREATE. These limits are generous; Base gas is cheap and
    // unused gas is refunded.
    const factory = new ContractFactory(
      [],
      Poseidon2HuffJson.bytecode,
      deployer,
    );
    const poseidon2Huff = await factory.deploy({ gasLimit: 3_000_000n });
    await poseidon2Huff.waitForDeployment();
    poseidon2HuffAddress = await poseidon2Huff.getAddress();
    // setPoseidon computes the 12 zero-subtree roots (11 hasher calls +
    // storage writes), so it needs far more than a simple setter.
    await (
      await pampalo.setPoseidon(poseidon2HuffAddress, { gasLimit: 2_000_000n })
    ).wait();
    console.log(`  Poseidon set: ${poseidon2HuffAddress}`);
    await sleep(STEP_SLEEP_MS);
  }

  // Oracles (USDC/USD + ETH/USD; WETH reuses the ETH feed).
  const ChainlinkOracleFactory =
    await connection.ethers.getContractFactory("ChainlinkOracle");
  const usdcOracle = await ChainlinkOracleFactory.deploy(
    cfg.feeds.usdc.feed,
    cfg.feeds.usdc.maxAge,
    { gasLimit: 1_000_000n },
  );
  await usdcOracle.waitForDeployment();
  const usdcOracleAddress = await usdcOracle.getAddress();
  await sleep(STEP_SLEEP_MS);
  const ethOracle = await ChainlinkOracleFactory.deploy(
    cfg.feeds.eth.feed,
    cfg.feeds.eth.maxAge,
    { gasLimit: 1_000_000n },
  );
  await ethOracle.waitForDeployment();
  const ethOracleAddress = await ethOracle.getAddress();
  await sleep(STEP_SLEEP_MS);

  // Register real supported assets: USDC, WETH, ETH.
  const launchSet = [
    { name: "USDC", address: cfg.usdc, oracle: usdcOracleAddress, decimals: 6 },
    { name: "WETH", address: cfg.weth, oracle: ethOracleAddress, decimals: 18 },
    { name: "ETH", address: ETH_ADDRESS, oracle: ethOracleAddress, decimals: 18 },
  ];
  for (const a of launchSet) {
    const existing = await pampalo.supportedAssets(a.address);
    if (existing.enabled) {
      console.log(`  ${a.name.padEnd(5)} already supported`);
      continue;
    }
    await (
      await pampalo.addSupportedAsset(a.address, a.oracle, a.decimals, {
        gasLimit: 200_000n,
      })
    ).wait();
    console.log(`  ${a.name.padEnd(5)} registered`);
    await sleep(STEP_SLEEP_MS);
  }

  return {
    venue,
    pampalo: pampaloAddress,
    poseidon2Huff: poseidon2HuffAddress,
    venueAddress: venueAddr,
    swapVerifier: await result.swapVerifier.getAddress(),
    verifiers: {
      deposit: await result.depositVerifier.getAddress(),
      transfer: await result.transferVerifier.getAddress(),
      withdraw: await result.withdrawVerifier.getAddress(),
      transferExternal: await result.transferExternalVerifier.getAddress(),
    },
    oracles: { usdc: usdcOracleAddress, eth: ethOracleAddress },
  };
}

async function main() {
  const connection = await hre.network.connect();
  const signers = await connection.ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error("No signer at accounts[0]. Set MNEMONIC in env.");
  }
  const provider = deployer.provider!;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  const cfg = CHAINS[chainId];
  if (!cfg) {
    throw new Error(
      `No swap config for chainId ${chainId}. Add an entry to CHAINS in scripts/deploy-swap.ts.`,
    );
  }

  const venues = (process.env.SWAP_VENUES ?? "v3,v4")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is "v3" | "v4" => s === "v3" || s === "v4");
  if (venues.length === 0) throw new Error("SWAP_VENUES must list v3 and/or v4");

  console.log(`▸ Network  : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Deployer : ${deployer.address}`);
  console.log(
    `▸ Balance  : ${(await provider.getBalance(deployer.address)).toString()} wei`,
  );
  console.log(`▸ Venues   : ${venues.join(", ")}`);

  const deployed: Record<string, unknown>[] = [];
  for (const venue of venues) {
    deployed.push(
      await deployVenue({ connection, venue, cfg, chainId, deployer }),
    );
  }

  const outPath = path.join("deployments", `${chainId}-swap.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        chainId,
        network: net.name || `chain-${chainId}`,
        deployer: deployer.address,
        tokens: { usdc: cfg.usdc, weth: cfg.weth },
        venues: deployed,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\n✓ Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

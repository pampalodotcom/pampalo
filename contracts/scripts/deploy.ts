import { ContractFactory } from "ethers";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import hre from "hardhat";

import PampaloModule from "@/ignition/modules/Pampalo.js";
import TokensModule from "@/ignition/modules/Tokens.js";
import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// Full deployment for a fresh Pampalo install on a public network.
//
// Steps (each idempotent — re-running on the same chain is safe):
//   1. USDC mock via Ignition
//   2. Pampalo + the four verifiers via Ignition
//   3. Poseidon2 huff hasher (raw bytecode, ContractFactory)
//   4. pampalo.setPoseidon(...) — only if not already set
//   5. ChainlinkOracle adapters — one per Chainlink feed on this chain
//   6. pampalo.addSupportedAsset(...) for USDC and ETH
//   7. Write deployments/<chainId>.json with all addresses
//
// Oracle note: Eth Sepolia and Base Sepolia both have live Chainlink
// AggregatorV3 feeds for ETH/USD and USDC/USD, so the deploy registers
// ChainlinkOracle adapters that read from those directly.
//
// Usage:
//   hardhat run scripts/deploy.ts --network sepolia
//   hardhat run scripts/deploy.ts --network baseSepolia

const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// Pause between major steps. On Base Sepolia we've seen Ignition's
// journal get out of sync with the on-chain nonce when txs are
// submitted back-to-back through Alchemy — a brief sleep gives the
// RPC node time to settle and reduces the chance of a dropped tx
// poisoning the next deploy. Not a real fix (a future pass should add
// tx-replacement on timeout), just padding.
const STEP_SLEEP_MS = 3000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Chainlink AggregatorV3 feed addresses + staleness windows, keyed by
// chainId. `maxAge` is ~2× the documented Chainlink heartbeat so
// testnet lag doesn't bounce reads off the `stale price` revert.
// Tighten before mainnet.
//   Sepolia      ETH/USD   heartbeat 3600s
//   Sepolia      USDC/USD  heartbeat 86400s
//   Base Sepolia ETH/USD   (heartbeat not published; cap conservatively)
//   Base Sepolia USDC/USD  (heartbeat not published; cap conservatively)
const CHAINLINK_FEEDS: Record<
  number,
  {
    eth: { feed: string; maxAge: number };
    usdc: { feed: string; maxAge: number };
  }
> = {
  // Ethereum Sepolia
  11155111: {
    eth: {
      feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
      maxAge: 7200,
    },
    usdc: {
      feed: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
      maxAge: 172800,
    },
  },
  // Base Sepolia
  84532: {
    eth: {
      feed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
      maxAge: 7200,
    },
    usdc: {
      feed: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
      maxAge: 172800,
    },
  },
};

async function main() {
  const connection = await hre.network.connect();
  const signers = await connection.ethers.getSigners();
  const deployer = signers[0];

  if (!deployer) {
    throw new Error(
      "No signer at accounts[0]. Set MNEMONIC in contracts/.env (or repo-root .env.local).",
    );
  }

  const provider = deployer.provider!;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  const feeds = CHAINLINK_FEEDS[chainId];
  if (!feeds) {
    throw new Error(
      `No Chainlink feed config for chainId ${chainId}. Add an entry to CHAINLINK_FEEDS in scripts/deploy.ts.`,
    );
  }

  console.log(`▸ Network        : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Deployer       : ${deployer.address}`);
  console.log(`▸ Deployer ETH   : ${(await provider.getBalance(deployer.address)).toString()}`);
  console.log("");

  // ── 1. Token mocks ──────────────────────────────────────────────────
  console.log("[1/7] Deploying USDC mock via Ignition...");
  const { usdcDeployment } = await connection.ignition.deploy(TokensModule);
  const usdcAddress = await usdcDeployment.getAddress();
  console.log(`  USDC mock : ${usdcAddress}`);
  await sleep(STEP_SLEEP_MS);

  // ── 2. Pampalo + verifiers ──────────────────────────────────────────
  console.log("\n[2/7] Deploying Pampalo + the four verifiers via Ignition...");
  const {
    pampalo,
    depositVerifier,
    transferVerifier,
    withdrawVerifier,
    transferExternalVerifier,
  } = await connection.ignition.deploy(PampaloModule);
  const pampaloAddress = await pampalo.getAddress();
  console.log(`  Pampalo                  : ${pampaloAddress}`);
  console.log(`  DepositVerifier          : ${await depositVerifier.getAddress()}`);
  console.log(`  TransferVerifier         : ${await transferVerifier.getAddress()}`);
  console.log(`  WithdrawVerifier         : ${await withdrawVerifier.getAddress()}`);
  console.log(`  TransferExternalVerifier : ${await transferExternalVerifier.getAddress()}`);
  await sleep(STEP_SLEEP_MS);

  // ── 3-4. Poseidon2 huff + setPoseidon ───────────────────────────────
  console.log("\n[3/7] Checking Poseidon2 hasher state...");
  const existingHasher = await pampalo.poseidon2Hasher();
  let poseidon2HuffAddress: string;

  if (existingHasher !== "0x0000000000000000000000000000000000000000") {
    poseidon2HuffAddress = existingHasher;
    console.log(`  Already set: ${existingHasher}`);
  } else {
    console.log("  Deploying Poseidon2 huff bytecode via ContractFactory...");
    const factory = new ContractFactory(
      [],
      Poseidon2HuffJson.bytecode,
      deployer,
    );
    const poseidon2Huff = await factory.deploy();
    await poseidon2Huff.waitForDeployment();
    poseidon2HuffAddress = await poseidon2Huff.getAddress();
    console.log(`  Deployed: ${poseidon2HuffAddress}`);
    await sleep(STEP_SLEEP_MS);

    console.log("\n[4/7] Calling pampalo.setPoseidon(...)");
    await (await pampalo.setPoseidon(poseidon2HuffAddress)).wait();
    console.log("  setPoseidon confirmed.");
    await sleep(STEP_SLEEP_MS);
  }

  // ── 5. Oracles ──────────────────────────────────────────────────────
  console.log("\n[5/7] Deploying ChainlinkOracle adapters...");
  const ChainlinkOracleFactory =
    await connection.ethers.getContractFactory("ChainlinkOracle");

  const usdcOracle = await ChainlinkOracleFactory.deploy(
    feeds.usdc.feed,
    feeds.usdc.maxAge,
  );
  await usdcOracle.waitForDeployment();
  const usdcOracleAddress = await usdcOracle.getAddress();
  console.log(
    `  USDC adapter (feed ${feeds.usdc.feed}, maxAge ${feeds.usdc.maxAge}s) : ${usdcOracleAddress}`,
  );
  await sleep(STEP_SLEEP_MS);

  const ethOracle = await ChainlinkOracleFactory.deploy(
    feeds.eth.feed,
    feeds.eth.maxAge,
  );
  await ethOracle.waitForDeployment();
  const ethOracleAddress = await ethOracle.getAddress();
  console.log(
    `  ETH  adapter (feed ${feeds.eth.feed}, maxAge ${feeds.eth.maxAge}s) : ${ethOracleAddress}`,
  );
  await sleep(STEP_SLEEP_MS);

  // ── 6. Register supported assets ────────────────────────────────────
  console.log("\n[6/7] Registering supported assets...");
  const launchSet = [
    { name: "USDC", address: usdcAddress, oracle: usdcOracleAddress, decimals: 6 },
    { name: "ETH", address: ETH_ADDRESS, oracle: ethOracleAddress, decimals: 18 },
  ];

  for (const a of launchSet) {
    const existing = await pampalo.supportedAssets(a.address);
    if (existing.enabled) {
      console.log(`  ${a.name.padEnd(8)} already supported, skipping`);
      continue;
    }
    await (
      await pampalo.addSupportedAsset(a.address, a.oracle, a.decimals)
    ).wait();
    console.log(`  ${a.name.padEnd(8)} registered (decimals=${a.decimals})`);
    await sleep(STEP_SLEEP_MS);
  }

  // ── 7. Write deployments JSON ───────────────────────────────────────
  const deployment = {
    chainId,
    network: net.name || `chain-${chainId}`,
    deployer: deployer.address,
    pampalo: pampaloAddress,
    poseidon2Huff: poseidon2HuffAddress,
    verifiers: {
      deposit: await depositVerifier.getAddress(),
      transfer: await transferVerifier.getAddress(),
      withdraw: await withdrawVerifier.getAddress(),
      transferExternal: await transferExternalVerifier.getAddress(),
    },
    tokens: {
      usdc: usdcAddress,
    },
    oracles: {
      usdc: usdcOracleAddress,
      eth: ethOracleAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const outPath = path.join("deployments", `${chainId}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\n[7/7] Wrote ${outPath}`);
  console.log("\n✓ Deployment complete.");
  console.log("\nNext steps:");
  console.log(
    "  • Mint test tokens to your stress-test accounts: usdc.mint(addr, amount)",
  );
  console.log(
    "  • Bump caps for stress-test addresses: pampalo.setAddressMonthlyCap(addr, usdCents)",
  );
  console.log("  • Verify contracts on Etherscan/Basescan:");
  console.log(
    `      pnpm --filter @pampalo/contracts exec hardhat ignition verify pampalo --network ${net.name || `chain-${chainId}`}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

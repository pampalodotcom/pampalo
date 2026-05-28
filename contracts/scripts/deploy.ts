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
//   1. Token mocks (USDC, FourDEC) via Ignition
//   2. Pampalo + the four verifiers via Ignition
//   3. Poseidon2 huff hasher (raw bytecode, ContractFactory)
//   4. pampalo.setPoseidon(...) — only if not already set
//   5. MockOracle x2 — one for USDC ($1/USDC), one for ETH ($3000/ETH)
//   6. pampalo.addSupportedAsset(...) for USDC, ETH, FourDEC
//   7. Write deployments/<chainId>.json with all addresses
//
// Pricing note: MockOracle is used for both testnets so stress-test
// runs have predictable USD math. Swap to ChainlinkOracle (already
// implemented) before mainnet — see CONTRACTS_PLAN.md §4.3.
//
// Usage:
//   hardhat run scripts/deploy.ts --network sepolia
//   hardhat run scripts/deploy.ts --network baseSepolia

const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const USDC_PRICE_CENTS_PER_UNIT = 100n; // 1 USDC = $1.00 = 100 cents
const ETH_PRICE_CENTS_PER_UNIT = 300_000n; // 1 ETH = $3000.00 = 300_000 cents
// (priceUsdCents formula divides by 10^assetDecimals so the "per unit"
// price is the natural USD-cents-per-1-of-asset value.)

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

  console.log(`▸ Network        : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Deployer       : ${deployer.address}`);
  console.log(`▸ Deployer ETH   : ${(await provider.getBalance(deployer.address)).toString()}`);
  console.log("");

  // ── 1. Token mocks ──────────────────────────────────────────────────
  console.log("[1/7] Deploying token mocks (USDC, FourDEC) via Ignition...");
  const { usdcDeployment, fourDecDeployment } = await connection.ignition.deploy(
    TokensModule,
  );
  const usdcAddress = await usdcDeployment.getAddress();
  const fourDecAddress = await fourDecDeployment.getAddress();
  console.log(`  USDC mock    : ${usdcAddress}`);
  console.log(`  FourDEC mock : ${fourDecAddress}`);

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

    console.log("\n[4/7] Calling pampalo.setPoseidon(...)");
    await (await pampalo.setPoseidon(poseidon2HuffAddress)).wait();
    console.log("  setPoseidon confirmed.");
  }

  // ── 5. Oracles ──────────────────────────────────────────────────────
  console.log("\n[5/7] Deploying MockOracle instances...");
  const MockOracleFactory =
    await connection.ethers.getContractFactory("MockOracle");

  const usdcOracle = await MockOracleFactory.deploy(USDC_PRICE_CENTS_PER_UNIT);
  await usdcOracle.waitForDeployment();
  const usdcOracleAddress = await usdcOracle.getAddress();
  console.log(`  USDC oracle (\$1.00/USDC)  : ${usdcOracleAddress}`);

  const ethOracle = await MockOracleFactory.deploy(ETH_PRICE_CENTS_PER_UNIT);
  await ethOracle.waitForDeployment();
  const ethOracleAddress = await ethOracle.getAddress();
  console.log(`  ETH oracle (\$3000.00/ETH) : ${ethOracleAddress}`);

  // ── 6. Register supported assets ────────────────────────────────────
  console.log("\n[6/7] Registering supported assets...");
  const launchSet = [
    { name: "USDC", address: usdcAddress, oracle: usdcOracleAddress, decimals: 6 },
    { name: "ETH", address: ETH_ADDRESS, oracle: ethOracleAddress, decimals: 18 },
    {
      name: "FourDEC",
      address: fourDecAddress,
      oracle: usdcOracleAddress,
      decimals: 4,
    },
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
      fourDec: fourDecAddress,
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

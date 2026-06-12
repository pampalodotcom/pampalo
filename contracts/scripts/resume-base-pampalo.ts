import { ContractFactory, getCreateAddress, type Provider } from "ethers";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import hre from "hardhat";

import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// One-off recovery for the Base mainnet (8453) deploy that Ignition got
// stuck on (HHE10404 → HHE100, journal unrecoverable). The deployer
// (MNEMONIC idx 1, 0x77c2…f054) had USDC mock + 4DEC + the 3 verifier libs
// (nonces 0–4) on-chain. This continues the EXACT nonce sequence so every
// contract — including Pampalo at nonce 10 — lands at the same address as
// Base Sepolia. Resumable + every deploy is asserted against its expected
// CREATE address; any mismatch aborts before doing damage.
//
//   nonce 5  → WithdrawVerifier's ZKTranscriptLib
//   nonce 6  → DepositVerifier          (lib @2)
//   nonce 7  → TransferExternalVerifier  (lib @3)
//   nonce 8  → TransferVerifier          (lib @4)
//   nonce 9  → WithdrawVerifier          (lib @5)
//   nonce 10 → Pampalo(deposit, transfer, withdraw, transferExternal)
//   nonce 11 → Poseidon2 huff ; 12 → setPoseidon ; 13/14 → oracles ; +assets
//
// Usage: pnpm hardhat run scripts/resume-base-pampalo.ts --network base

const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC_MOCK = "0x445b24Cf4Ac9AC20ecc417Ac41160Fdc8088520d";
const TARGET_PAMPALO = "0x86cC802B2d5a9EF41194E68ed69EeCC37AdAAf59";

const FEEDS = {
  eth: { feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", maxAge: 7200 },
  usdc: { feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", maxAge: 172800 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForNonce(p: Provider, a: string, n: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    if ((await p.getTransactionCount(a, "latest")) >= n) return;
    await sleep(2000);
  }
  throw new Error(`waitForNonce timeout: ${a} expected ${n}`);
}

async function main() {
  const connection = await hre.network.connect();
  const [deployer] = await connection.ethers.getSigners();
  if (!deployer) throw new Error("no signer — set MNEMONIC");
  const provider = deployer.provider!;
  const from = deployer.address;

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 8453) {
    throw new Error(`Base mainnet only (got chainId ${net.chainId})`);
  }
  console.log(
    `▸ Deployer : ${from} (nonce ${await provider.getTransactionCount(from, "latest")})\n`,
  );

  const expect = (n: number) => getCreateAddress({ from, nonce: n });

  // Deploy the contract that belongs at `nonce`, unless it's already there
  // (resume). Asserts the result lands on the deterministic CREATE address.
  const ensureDeployed = async (
    label: string,
    nonce: number,
    deployFn: () => Promise<{ getAddress(): Promise<string> }>,
  ): Promise<string> => {
    const want = expect(nonce);
    if ((await provider.getCode(want)) !== "0x") {
      console.log(`  ${label.padEnd(26)} ${want}  (nonce ${nonce}, present)`);
      return want;
    }
    const cur = await provider.getTransactionCount(from, "latest");
    if (cur !== nonce) {
      throw new Error(
        `${label}: deployer at nonce ${cur} but this step needs ${nonce} — aborting.`,
      );
    }
    const c = await deployFn();
    const got = await c.getAddress();
    if (got.toLowerCase() !== want.toLowerCase()) {
      throw new Error(`${label} → ${got}, expected ${want} — aborting.`);
    }
    console.log(`  ${label.padEnd(26)} ${got}  (nonce ${nonce} ✓)`);
    await waitForNonce(provider, from, nonce + 1);
    await sleep(3000);
    return got;
  };

  // Sanity: the 3 existing verifier libs (nonces 2–4) must be on-chain.
  for (const n of [2, 3, 4]) {
    if ((await provider.getCode(expect(n))) === "0x") {
      throw new Error(`expected lib code at nonce ${n} (${expect(n)}) — aborting.`);
    }
  }

  const libFor = (v: string) =>
    `project/contracts/verifiers/${v}.sol:ZKTranscriptLib`;

  // nonce 5 — WithdrawVerifier's lib.
  console.log("[1/6] Verifier libraries...");
  const withdrawLib = await ensureDeployed("WithdrawVerifierLib", 5, async () => {
    const F = await connection.ethers.getContractFactory(
      "contracts/verifiers/WithdrawVerifier.sol:ZKTranscriptLib",
      deployer,
    );
    return F.deploy();
  });

  // nonces 6–9 — verifiers, each linked to its lib, in Base Sepolia order.
  console.log("\n[2/6] Verifiers...");
  const verifier = (v: string, libAddr: string, nonce: number) =>
    ensureDeployed(v, nonce, async () => {
      const F = await connection.ethers.getContractFactory(
        `contracts/verifiers/${v}.sol:${v}`,
        { libraries: { [libFor(v)]: libAddr }, signer: deployer },
      );
      return F.deploy();
    });
  const depositVerifier = await verifier("DepositVerifier", expect(2), 6);
  const transferExternalVerifier = await verifier(
    "TransferExternalVerifier",
    expect(3),
    7,
  );
  const transferVerifier = await verifier("TransferVerifier", expect(4), 8);
  const withdrawVerifier = await verifier("WithdrawVerifier", withdrawLib, 9);

  // nonce 10 — Pampalo(deposit, transfer, withdraw, transferExternal).
  console.log("\n[3/6] Pampalo...");
  const pampaloAddress = await ensureDeployed("Pampalo", 10, async () => {
    const F = await connection.ethers.getContractFactory("Pampalo", deployer);
    return F.deploy(
      depositVerifier,
      transferVerifier,
      withdrawVerifier,
      transferExternalVerifier,
    );
  });
  const pampalo = await connection.ethers.getContractAt(
    "Pampalo",
    pampaloAddress,
    deployer,
  );

  // nonce 11 — Poseidon2 huff ; 12 — setPoseidon.
  console.log("\n[4/6] Poseidon2 huff + setPoseidon...");
  const poseidon2HuffAddress = await ensureDeployed("Poseidon2Huff", 11, async () => {
    const f = new ContractFactory([], Poseidon2HuffJson.bytecode, deployer);
    return f.deploy();
  });
  if (
    (await pampalo.poseidon2Hasher()) ===
    "0x0000000000000000000000000000000000000000"
  ) {
    await (await pampalo.setPoseidon(poseidon2HuffAddress)).wait();
    console.log("  setPoseidon confirmed.");
    await sleep(3000);
  } else {
    console.log("  poseidon already set.");
  }

  // Oracles + assets.
  console.log("\n[5/6] Oracles + supported assets...");
  const OracleF = await connection.ethers.getContractFactory("ChainlinkOracle");
  const usdcOracle = await OracleF.deploy(FEEDS.usdc.feed, FEEDS.usdc.maxAge);
  await usdcOracle.waitForDeployment();
  const usdcOracleAddress = await usdcOracle.getAddress();
  console.log(`  USDC oracle : ${usdcOracleAddress}`);
  await sleep(3000);
  const ethOracle = await OracleF.deploy(FEEDS.eth.feed, FEEDS.eth.maxAge);
  await ethOracle.waitForDeployment();
  const ethOracleAddress = await ethOracle.getAddress();
  console.log(`  ETH  oracle : ${ethOracleAddress}`);
  await sleep(3000);

  for (const a of [
    { name: "USDC", address: USDC_MOCK, oracle: usdcOracleAddress, decimals: 6 },
    { name: "ETH", address: ETH_ADDRESS, oracle: ethOracleAddress, decimals: 18 },
  ]) {
    if ((await pampalo.supportedAssets(a.address)).enabled) {
      console.log(`  ${a.name} already supported`);
      continue;
    }
    await (await pampalo.addSupportedAsset(a.address, a.oracle, a.decimals)).wait();
    console.log(`  ${a.name} registered`);
    await sleep(3000);
  }

  console.log("\n[6/6] Writing deployments/8453.json...");
  const deployment = {
    chainId: 8453,
    network: "base",
    deployer: from,
    pampalo: pampaloAddress,
    poseidon2Huff: poseidon2HuffAddress,
    verifiers: {
      deposit: depositVerifier,
      transfer: transferVerifier,
      withdraw: withdrawVerifier,
      transferExternal: transferExternalVerifier,
    },
    tokens: { usdc: USDC_MOCK },
    oracles: { usdc: usdcOracleAddress, eth: ethOracleAddress },
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join("deployments", "8453.json"),
    JSON.stringify(deployment, null, 2) + "\n",
  );

  console.log(`\n✓ Resume complete. Pampalo @ ${pampaloAddress}`);
  console.log(
    pampaloAddress.toLowerCase() === TARGET_PAMPALO.toLowerCase()
      ? "  ✓ ADDRESS MATCHES Base Sepolia."
      : "  ✗ address does NOT match — investigate.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

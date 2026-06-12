import { getCreateAddress, type Provider } from "ethers";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import hre from "hardhat";

// Deploy the PampaloPayments settlement singleton (+ its RedeemVerifier)
// against an ALREADY-LIVE Pampalo, WITHOUT Ignition.
//
// Why not Ignition: `ignition/modules/PampaloPayments.ts` does
// `useModule(PampaloModule)`, but the Base mainnet (8453) Ignition journal
// never recorded Pampalo (it was finished out-of-band by
// resume-base-pampalo.ts). Running that module on mainnet would try to
// REDEPLOY Pampalo. So we deploy the two new contracts directly via
// ethers, reading the live Pampalo address from deployments/<chainId>.json
// and passing it to the PampaloPayments constructor.
//
// Address parity across chains: PampaloPayments must land at the SAME
// address on Base + Base Sepolia. A CREATE address is f(deployer, nonce),
// so the deployer must START this 3-tx sequence (RedeemVerifier lib →
// RedeemVerifier → PampaloPayments) at the SAME nonce on both chains —
// REQUIRED_START_NONCE. Every address is anchored to that nonce and
// asserted before the next tx, so the script is resumable (skips steps
// whose code already exists) and physically cannot deploy to a mismatched
// address (same discipline as resume-base-pampalo.ts).
//
// Usage:
//   pnpm --filter @pampalo/contracts exec hardhat run scripts/deploy-payments.ts --network baseSepolia
//   pnpm --filter @pampalo/contracts exec hardhat run scripts/deploy-payments.ts --network base

// The nonce both chains must start this deploy at, so the CREATE addresses
// match. Base Sepolia sits here; Base mainnet is brought here first by
// running grant-roles.ts (4 txs: 17 → 21). Override via env if needed.
const REQUIRED_START_NONCE = Number(process.env.PAYMENTS_START_NONCE ?? "21");

// getContractFactory resolves the library by its plain source name; the
// linker (libraries map) wants Hardhat 3's `project/`-prefixed name.
const ZKTRANSCRIPT_LIB_FQN =
  "contracts/verifiers/RedeemVerifier.sol:ZKTranscriptLib";
const ZKTRANSCRIPT_LIB_LINK =
  "project/contracts/verifiers/RedeemVerifier.sol:ZKTranscriptLib";

const STEP_SLEEP_MS = 3000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Base + Alchemy's getTransactionCount lags a just-mined tx by a few
// seconds; wait for it to catch up before the next deploy. Mirrors deploy.ts.
const waitForNonce = async (
  provider: Provider,
  address: string,
  expected: number,
  timeoutMs = 120_000,
): Promise<void> => {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    const actual = await provider.getTransactionCount(address, "latest");
    if (actual >= expected) return;
    last = actual;
    await sleep(2000);
  }
  throw new Error(
    `waitForNonce timeout for ${address}: expected ${expected}, last seen ${last}`,
  );
};

async function main() {
  const connection = await hre.network.connect();
  const signers = await connection.ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      "No signer at accounts[0]. Set MNEMONIC in repo-root .env.local.",
    );
  }
  const provider = deployer.provider!;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  const deploymentPath = path.join("deployments", `${chainId}.json`);
  const deployment = JSON.parse(await fs.readFile(deploymentPath, "utf8")) as {
    pampalo: string;
    payments?: string;
    redeemVerifier?: string;
  };
  const pampaloAddress = deployment.pampalo;

  console.log(`▸ Network   : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Deployer  : ${deployer.address}`);
  console.log(`▸ Pampalo   : ${pampaloAddress}`);

  // Addresses are anchored to REQUIRED_START_NONCE so they're identical
  // across chains and stable across resumes.
  const expectLib = getCreateAddress({
    from: deployer.address,
    nonce: REQUIRED_START_NONCE,
  });
  const expectVerifier = getCreateAddress({
    from: deployer.address,
    nonce: REQUIRED_START_NONCE + 1,
  });
  const expectPayments = getCreateAddress({
    from: deployer.address,
    nonce: REQUIRED_START_NONCE + 2,
  });
  console.log("");
  console.log(`  ZKTranscriptLib : ${expectLib}`);
  console.log(`  RedeemVerifier  : ${expectVerifier}`);
  console.log(`  PampaloPayments : ${expectPayments}`);
  console.log("");

  const assertAddr = (label: string, got: string, want: string): void => {
    if (got.toLowerCase() !== want.toLowerCase()) {
      throw new Error(
        `${label} deployed to ${got} but expected ${want}. Aborting.`,
      );
    }
  };
  const hasCode = async (addr: string): Promise<boolean> =>
    (await provider.getCode(addr)) !== "0x";
  const requireNonce = async (want: number, label: string): Promise<void> => {
    const n = await provider.getTransactionCount(deployer.address, "latest");
    if (n !== want) {
      throw new Error(
        `Deployer nonce is ${n}, need ${want} to deploy ${label} at the ` +
          `address that matches across chains. Aborting.`,
      );
    }
  };

  // ── 1. RedeemVerifier's ZKTranscriptLib (nonce N) ───────────────────
  if (await hasCode(expectLib)) {
    console.log("[1/3] ZKTranscriptLib already deployed — skipping");
  } else {
    console.log("[1/3] Deploying ZKTranscriptLib...");
    await requireNonce(REQUIRED_START_NONCE, "ZKTranscriptLib");
    const LibFactory =
      await connection.ethers.getContractFactory(ZKTRANSCRIPT_LIB_FQN);
    const lib = await LibFactory.deploy();
    await lib.waitForDeployment();
    assertAddr("ZKTranscriptLib", await lib.getAddress(), expectLib);
    console.log(`  ZKTranscriptLib : ${expectLib}`);
    await waitForNonce(provider, deployer.address, REQUIRED_START_NONCE + 1);
    await sleep(STEP_SLEEP_MS);
  }

  // ── 2. RedeemVerifier, linked to the lib (nonce N+1) ────────────────
  if (await hasCode(expectVerifier)) {
    console.log("[2/3] RedeemVerifier already deployed — skipping");
  } else {
    console.log("\n[2/3] Deploying RedeemVerifier...");
    await requireNonce(REQUIRED_START_NONCE + 1, "RedeemVerifier");
    const VerifierFactory = await connection.ethers.getContractFactory(
      "RedeemVerifier",
      { libraries: { [ZKTRANSCRIPT_LIB_LINK]: expectLib } },
    );
    const verifier = await VerifierFactory.deploy();
    await verifier.waitForDeployment();
    assertAddr("RedeemVerifier", await verifier.getAddress(), expectVerifier);
    console.log(`  RedeemVerifier : ${expectVerifier}`);
    await waitForNonce(provider, deployer.address, REQUIRED_START_NONCE + 2);
    await sleep(STEP_SLEEP_MS);
  }

  // ── 3. PampaloPayments(pampalo, redeemVerifier) (nonce N+2) ─────────
  if (await hasCode(expectPayments)) {
    console.log("[3/3] PampaloPayments already deployed — skipping");
  } else {
    console.log("\n[3/3] Deploying PampaloPayments...");
    await requireNonce(REQUIRED_START_NONCE + 2, "PampaloPayments");
    const PaymentsFactory =
      await connection.ethers.getContractFactory("PampaloPayments");
    const payments = await PaymentsFactory.deploy(
      pampaloAddress,
      expectVerifier,
    );
    await payments.waitForDeployment();
    assertAddr("PampaloPayments", await payments.getAddress(), expectPayments);
    console.log(`  PampaloPayments : ${expectPayments}`);
  }

  // ── Record into deployments/<chainId>.json ──────────────────────────
  const updated = {
    ...deployment,
    redeemVerifier: expectVerifier,
    payments: expectPayments,
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(deploymentPath, JSON.stringify(updated, null, 2) + "\n");
  console.log(`\n✓ Wrote ${deploymentPath}`);
  console.log("\n✓ PampaloPayments deployment complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

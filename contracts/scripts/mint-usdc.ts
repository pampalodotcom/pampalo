import * as fs from "node:fs/promises";
import * as path from "node:path";
import hre from "hardhat";

// Mint mock USDC to a recipient on whatever network is passed via
// --network. The USDC mock's `mint(address,uint256)` is unguarded, so
// any signer can call it — handy for topping up stress-test accounts.
//
// Usage:
//   hardhat run scripts/mint-usdc.ts --network baseSepolia
//
// Recipient + amount are configurable via env (defaults below):
//   MINT_TO     recipient address
//   MINT_AMOUNT whole USDC to mint (e.g. "1000"); scaled by 1e6 here

const DEFAULT_RECIPIENT = "0x301765d9Cc1fb414b4c510997a562f155d2C2A84";
const DEFAULT_AMOUNT_USDC = "10";
const USDC_DECIMALS = 6;

async function main() {
  const connection = await hre.network.connect();
  const signers = await connection.ethers.getSigners();
  const sender = signers[0];

  if (!sender) {
    throw new Error(
      "No signer at accounts[0]. Set MNEMONIC in contracts/.env (or repo-root .env.local).",
    );
  }

  const provider = sender.provider!;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  // Resolve the deployed USDC mock from the recorded deployment.
  const deploymentPath = path.join("deployments", `${chainId}.json`);
  let usdcAddress: string;
  try {
    const raw = await fs.readFile(deploymentPath, "utf8");
    usdcAddress = JSON.parse(raw).tokens?.usdc;
  } catch {
    throw new Error(
      `No deployment file at ${deploymentPath}. Deploy first with scripts/deploy.ts.`,
    );
  }
  if (!usdcAddress) {
    throw new Error(`No tokens.usdc address in ${deploymentPath}.`);
  }

  const recipient = process.env.MINT_TO ?? DEFAULT_RECIPIENT;
  const amount = connection.ethers.parseUnits(
    process.env.MINT_AMOUNT ?? DEFAULT_AMOUNT_USDC,
    USDC_DECIMALS,
  );

  console.log(`▸ Network   : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Sender    : ${sender.address}`);
  console.log(`▸ USDC mock : ${usdcAddress}`);
  console.log(`▸ Recipient : ${recipient}`);
  console.log(
    `▸ Amount    : ${connection.ethers.formatUnits(amount, USDC_DECIMALS)} USDC`,
  );
  console.log("");

  const usdc = await connection.ethers.getContractAt("USDC", usdcAddress);

  const before = await usdc.balanceOf(recipient);
  console.log("Minting...");
  const tx = await usdc.mint(recipient, amount);
  console.log(`  tx: ${tx.hash}`);
  await tx.wait();
  const after = await usdc.balanceOf(recipient);

  console.log(
    `\n✓ Minted. Recipient balance ${connection.ethers.formatUnits(
      before,
      USDC_DECIMALS,
    )} → ${connection.ethers.formatUnits(after, USDC_DECIMALS)} USDC`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

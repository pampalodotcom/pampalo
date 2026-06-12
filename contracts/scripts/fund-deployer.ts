import { network } from "hardhat";
import { parseEther, formatEther } from "ethers";

// One-shot: send native ETH from accounts[0] (the original funded wallet)
// to the v2 deployer at MNEMONIC accounts[1]. That address is nonce-0 on
// both Base + Base Sepolia, so deploying from it gives identical CREATE
// addresses across the two chains. Run this BEFORE switching the deploy
// config to index 1 (otherwise accounts[0] === the target).
//
// Usage:
//   pnpm --filter @pampalo/contracts exec hardhat run scripts/fund-deployer.ts --network baseSepolia
//   FUND_AMOUNT_ETH=0.25 pnpm … (override the default amount)

const TARGET = "0x77c2D739A68A086e359B6be91B72a2533c53f054";
const AMOUNT_ETH = process.env.FUND_AMOUNT_ETH ?? "1";

async function main() {
  const connection = await network.connect();
  const signers = await connection.ethers.getSigners();
  const funder = signers[0];
  if (!funder) {
    throw new Error(
      "No signer at accounts[0]. Set MNEMONIC in contracts/.env (or repo-root .env.local).",
    );
  }
  if (funder.address.toLowerCase() === TARGET.toLowerCase()) {
    throw new Error(
      "Funder equals the target — run this BEFORE switching the deployer to index 1.",
    );
  }

  const provider = funder.provider!;
  const net = await provider.getNetwork();
  const amount = parseEther(AMOUNT_ETH);

  const funderBal = await provider.getBalance(funder.address);
  const targetBefore = await provider.getBalance(TARGET);

  console.log(`▸ Network : chainId ${net.chainId}`);
  console.log(`▸ Funder  : ${funder.address}  (${formatEther(funderBal)} ETH)`);
  console.log(`▸ Target  : ${TARGET}  (${formatEther(targetBefore)} ETH)`);
  console.log(`▸ Sending : ${AMOUNT_ETH} ETH\n`);

  if (funderBal < amount) {
    throw new Error(
      `Funder balance ${formatEther(funderBal)} ETH < send amount ${AMOUNT_ETH} ETH.`,
    );
  }

  const tx = await funder.sendTransaction({ to: TARGET, value: amount });
  console.log(`  sent — tx ${tx.hash}, waiting for confirmation...`);
  await tx.wait();

  const targetAfter = await provider.getBalance(TARGET);
  console.log(`\n✓ Funded. Target now holds ${formatEther(targetAfter)} ETH.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

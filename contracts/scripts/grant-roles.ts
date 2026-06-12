import { network } from "hardhat";
import { HDNodeWallet } from "ethers";
import { readFile } from "node:fs/promises";

// One-shot script: grants VIGILANT_CITIZEN_ROLE, FINANCE_MANAGER_ROLE,
// and BOOTH_OPERATOR_ROLE to a target address on the currently-active
// network's Pampalo deployment. Does NOT grant DEFAULT_ADMIN_ROLE — the
// deployer wallet keeps that.
//
// Idempotent: skips any role the target already holds.
//
// Usage:
//   pnpm --filter @pampalo/contracts exec hardhat run scripts/grant-roles.ts --network baseSepolia

const TARGET = "0x4882788474F4916110100d737489F2e8d673287B";

const ROLE_NAMES = [
  "VIGILANT_CITIZEN_ROLE",
  "FINANCE_MANAGER_ROLE",
  "BOOTH_OPERATOR_ROLE",
] as const;

async function main() {
  const connection = await network.connect();
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

  // Pull the Pampalo address from the deployments JSON written by
  // scripts/deploy.ts. Keeps this script chain-agnostic so the same
  // file works for Sepolia, Base Sepolia, etc.
  const deploymentPath = `./deployments/${chainId}.json`;
  const raw = await readFile(deploymentPath, "utf8");
  const deployment = JSON.parse(raw) as { pampalo: string };

  console.log(`▸ Network   : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Signer    : ${deployer.address}`);
  console.log(`▸ Pampalo   : ${deployment.pampalo}`);
  console.log(`▸ Target    : ${TARGET}`);
  console.log("");

  const pampalo = await connection.ethers.getContractAt(
    "Pampalo",
    deployment.pampalo,
    deployer,
  );

  for (const name of ROLE_NAMES) {
    const role: string = await pampalo.getFunction(name)();
    const already: boolean = await pampalo.getFunction("hasRole")(role, TARGET);
    if (already) {
      console.log(`  ${name.padEnd(22)} already held — skipping`);
      continue;
    }
    const tx = await pampalo.getFunction("grantRole")(role, TARGET);
    await tx.wait();
    console.log(`  ${name.padEnd(22)} granted (tx ${tx.hash})`);
  }

  // Compliance signer (index 5 of RELAYER_MNEMONIC) needs VIGILANT_CITIZEN
  // to auto-contest on this deployment. Roles are per-contract, so re-grant
  // on every redeploy. See ADR 0016/0017.
  const mnemonic = process.env.RELAYER_MNEMONIC;
  if (mnemonic) {
    const compliance = HDNodeWallet.fromPhrase(
      mnemonic,
      undefined,
      "m/44'/60'/0'/0/5",
    ).address;
    const role: string = await pampalo.getFunction("VIGILANT_CITIZEN_ROLE")();
    const already: boolean = await pampalo.getFunction("hasRole")(
      role,
      compliance,
    );
    if (already) {
      console.log(`  compliance signer ${compliance} already VIGILANT — skip`);
    } else {
      const tx = await pampalo.getFunction("grantRole")(role, compliance);
      await tx.wait();
      console.log(
        `  VIGILANT_CITIZEN_ROLE → compliance signer ${compliance} (tx ${tx.hash})`,
      );
    }
  } else {
    console.log("  RELAYER_MNEMONIC not set — skipped compliance-signer grant.");
  }

  console.log("\n✓ Role grants complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

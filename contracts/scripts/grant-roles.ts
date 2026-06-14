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

const TARGET = "0x301765d9Cc1fb414b4c510997a562f155d2C2A84";

const ROLE_NAMES = [
  "VIGILANT_CITIZEN_ROLE",
  "FINANCE_MANAGER_ROLE",
  "BOOTH_OPERATOR_ROLE",
] as const;

// Prefer the swap-venue deploy artifact (the live 3.0.0 contract) over the
// plain one, so role grants land on the contract the app actually points at.
async function resolvePampalo(chainId: number): Promise<string> {
  try {
    const swap = JSON.parse(
      await readFile(`./deployments/${chainId}-swap.json`, "utf8"),
    ) as { venues: { venue: string; pampalo: string }[] };
    const venue = process.env.SWAP_VENUE ?? "v3";
    const v = swap.venues.find((x) => x.venue === venue) ?? swap.venues[0];
    if (v) return v.pampalo;
  } catch {
    // No swap artifact for this chain — fall through to the plain deploy.
  }
  const plain = JSON.parse(
    await readFile(`./deployments/${chainId}.json`, "utf8"),
  ) as { pampalo: string };
  return plain.pampalo;
}

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

  // Resolve the live Pampalo address. Prefer the swap-venue artifact
  // (deployments/<chainId>-swap.json — the 3.0.0 PampaloSwapV3/V4 deploy, ADR
  // 0024); fall back to the plain deploy artifact for non-swap chains.
  // SWAP_VENUE selects the venue (default v3). PampaloSwapV3 inherits Pampalo's
  // role functions, so the "Pampalo" ABI below works either way.
  const pampaloAddress = await resolvePampalo(chainId);

  console.log(`▸ Network   : ${net.name || "unknown"} (chainId ${chainId})`);
  console.log(`▸ Signer    : ${deployer.address}`);
  console.log(`▸ Pampalo   : ${pampaloAddress}`);
  console.log(`▸ Target    : ${TARGET}`);
  console.log("");

  const pampalo = await connection.ethers.getContractAt(
    "Pampalo",
    pampaloAddress,
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
    console.log(
      "  RELAYER_MNEMONIC not set — skipped compliance-signer grant.",
    );
  }

  console.log("\n✓ Role grants complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

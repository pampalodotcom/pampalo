import hre from "hardhat";
import { HDNodeWallet, Mnemonic, Contract } from "ethers";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { poseidon2Hash } from "@zkpassport/poseidon2";

import { getShieldDetails } from "@/helpers/functions/shield.js";
import {
  getSwapDetails,
  encodeV3Path,
  encodeV4Route,
} from "@/helpers/functions/swap.js";
import { getNullifier } from "@/helpers/functions/get-nullifier.js";
import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { getMerkleTree } from "@/helpers/objects/poseidon-merkle-tree.js";
import { createInputNote, emptyInputNote } from "@/helpers/note-formatting.js";

// End-to-end live private swap against the deployed Base contracts:
//   1. shield USDC  -> queued note (also seeds the contract's pooled USDC)
//   2. executeShieldImmediate -> leaf inserted (deployer holds BOOTH role)
//   3. privateSwap  -> spend the note, swap USDC->WETH against real
//      liquidity, mint a fixed-output WETH note at T.
//
// Needs USDC in the deployer wallet. Picks the venue from SWAP_VENUE
// ("v3" default | "v4"), reads addresses from deployments/8453-swap.json.
//
// Usage:
//   SWAP_VENUE=v3 BASE_RPC_URL=https://mainnet.base.org \
//   hardhat run scripts/test-swap.ts --network base

const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const SHIELD_AMOUNT = 1_000_000n; // 1 USDC (6 dec)
const TARGET_OUTPUT = 1n; // T = 1 wei WETH floor (test: guarantee fill)
const V3_FEE = Number(process.env.SWAP_FEE ?? 500);
const V4_TICK_SPACING = 10;

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const PAMPALO = [
  "function nextPendingId() view returns (uint256)",
  "function currentRoot() view returns (uint256)",
  "function shield(address,uint256,bytes,bytes32[],bytes) returns (uint256)",
  "function executeShieldImmediate(uint256)",
  "function privateSwap(bytes,bytes32[],bytes,bytes[])",
  "event PrivateSwapExecuted(address indexed inputAsset, address indexed outputAsset, uint256 inputAmount, uint256 targetOutput, uint256 realizedOutput)",
];

async function main() {
  const venue = (process.env.SWAP_VENUE ?? "v3") as "v3" | "v4";
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) throw new Error("MNEMONIC not set");

  const connection = await hre.network.connect();
  const [hhSigner] = await connection.ethers.getSigners();
  const provider = hhSigner.provider;
  const wallet = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(mnemonic),
    `m/44'/60'/0'/0/1`,
  ).connect(provider);

  const raw = await fs.readFile(
    path.join("deployments", "8453-swap.json"),
    "utf8",
  );
  const dep = JSON.parse(raw) as {
    tokens: { usdc: string; weth: string };
    venues: { venue: string; pampalo: string }[];
  };
  const v = dep.venues.find((x) => x.venue === venue);
  if (!v) throw new Error(`venue ${venue} not in deployments`);
  const USDC = dep.tokens.usdc;
  const WETH = dep.tokens.weth;

  console.log(`▸ Venue    : ${venue} @ ${v.pampalo}`);
  console.log(`▸ Deployer : ${wallet.address}`);

  const usdc = new Contract(USDC, ERC20, wallet);
  const bal: bigint = await usdc.balanceOf(wallet.address);
  console.log(`▸ USDC bal : ${bal} (need ${SHIELD_AMOUNT})`);
  if (bal < SHIELD_AMOUNT) {
    throw new Error(
      `Not enough USDC. Send >= ${SHIELD_AMOUNT} USDC base units to ${wallet.address} on Base.`,
    );
  }

  const pampalo = new Contract(v.pampalo, PAMPALO, wallet);

  // Identity: owner = poseidon2([ownerSecret]); ownerSecret = key mod field.
  const ownerSecret = BigInt(wallet.privateKey) % FIELD;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());
  const noteSecret = (BigInt(Date.now()) * 1_000_003n) % FIELD;

  // 1. approve + shield.
  console.log("\n[1] approve + shield USDC...");
  await (
    await usdc.approve(v.pampalo, SHIELD_AMOUNT, { gasLimit: 120_000n })
  ).wait();

  const { proof: shieldProof } = await getShieldDetails({
    assetId: USDC,
    assetAmount: SHIELD_AMOUNT,
    secret: noteSecret,
    owner,
  });
  const pendingId: bigint = await pampalo.nextPendingId();
  const shieldTx = await pampalo.shield(
    USDC,
    SHIELD_AMOUNT,
    shieldProof.proof,
    shieldProof.publicInputs,
    "0x",
    { gasLimit: 4_000_000n },
  );
  await shieldTx.wait();
  console.log(`    shield tx: ${shieldTx.hash} (pendingId ${pendingId})`);

  // 2. executeShieldImmediate (skip the 1h wait; deployer holds BOOTH role).
  console.log("[2] executeShieldImmediate...");
  await (
    await pampalo.executeShieldImmediate(pendingId, { gasLimit: 1_500_000n })
  ).wait();

  // 3. Build off-chain tree, confirm root matches, generate swap proof.
  console.log("[3] building swap proof...");
  const leaf = BigInt(shieldProof.publicInputs[0]);
  const tree = await getMerkleTree();
  await tree.insert(leaf.toString(), 0);
  const offRoot = (await tree.getRoot()).toString();
  const onRoot = (await pampalo.currentRoot()).toString();
  if (offRoot !== onRoot) {
    throw new Error(`root mismatch off=${offRoot} on=${onRoot}`);
  }
  console.log(`    root ok: ${onRoot.slice(0, 14)}...`);

  const mp = await tree.getProof(0);
  const inputNote = createInputNote(
    USDC,
    SHIELD_AMOUNT,
    owner,
    ownerSecret,
    noteSecret,
    0n,
    mp.siblings,
    mp.indices,
  );
  const nullifier = await getNullifier(
    0n,
    owner,
    noteSecret,
    BigInt(USDC),
    SHIELD_AMOUNT,
  );
  const swapSecret = (noteSecret + 7n) % FIELD;
  const bHash = await getNoteHash(owner, swapSecret, BigInt(WETH), TARGET_OUTPUT);

  const { proof } = await getSwapDetails(
    tree,
    [inputNote, emptyInputNote, emptyInputNote],
    [nullifier, 0n, 0n],
    [bHash, 0n, 0n],
    {
      inputAsset: BigInt(USDC),
      inputAmount: SHIELD_AMOUNT,
      outputAsset: BigInt(WETH),
      targetOutput: TARGET_OUTPUT,
      swapOutputOwner: owner,
      swapOutputSecret: swapSecret,
      changeAmount: 0n,
      changeOwner: 0n,
      changeSecret: 0n,
    },
  );

  const route =
    venue === "v3"
      ? encodeV3Path([USDC, WETH], [V3_FEE])
      : encodeV4Route([
          {
            key: {
              currency0: USDC,
              currency1: WETH,
              fee: V3_FEE,
              tickSpacing: V4_TICK_SPACING,
              hooks: "0x0000000000000000000000000000000000000000",
            },
            zeroForOne: true,
          },
        ]);

  // 4. privateSwap.
  console.log("[4] privateSwap...");
  const swapTx = await pampalo.privateSwap(
    proof.proof,
    proof.publicInputs,
    route,
    [],
    { gasLimit: 6_000_000n },
  );
  const rcpt = await swapTx.wait();
  console.log(`\n✓ privateSwap tx: ${swapTx.hash}`);
  console.log(`  status: ${rcpt?.status} block: ${rcpt?.blockNumber}`);
  console.log(`  explorer: https://basescan.org/tx/${swapTx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

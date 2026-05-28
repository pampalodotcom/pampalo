import { getNoirClasses } from "@/helpers/objects/get-noir-classes.js";
import { getMerkleTree } from "@/helpers/objects/poseidon-merkle-tree.js";
import PampaloModule from "@/ignition/modules/Pampalo.js";
import TokensModule from "@/ignition/modules/Tokens.js";
import { ethers } from "ethers";
import hre from "hardhat";
import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// One-shot test fixture: deploys the Pampalo contract + verifier
// libraries, the token mocks (USDC, FourDEC), and the prebuilt
// Poseidon2 huff hasher. Returns the deployed contracts, the off-
// chain merkle tree mirror, the four bb.js classes pre-initialized,
// and the signers. Used by every Hardhat test in this suite.

export const getTestingAPI = async () => {
  const connection = await hre.network.connect();
  const Signers = await connection.ethers.getSigners();

  const deployer1Secret =
    "0x1234567890123456789012345678901234567890123456789012345678901234";
  const deployer2Secret =
    "0x9876543210987654321098765432109876543210987654321098765432109876";

  const { usdcDeployment, fourDecDeployment } =
    await connection.ignition.deploy(TokensModule);

  const { pampalo } = await connection.ignition.deploy(PampaloModule);

  // The Poseidon2 huff hasher ships as raw bytecode, not Solidity, so
  // we deploy it via ContractFactory with an empty ABI.
  const poseidon2HuffFactory = new ethers.ContractFactory(
    [],
    Poseidon2HuffJson.bytecode,
    Signers[0],
  );
  const poseidon2Huff = await poseidon2HuffFactory.deploy();
  await poseidon2Huff.waitForDeployment();
  const poseidon2Address = await poseidon2Huff.getAddress();

  await pampalo.setPoseidon(poseidon2Address);

  const {
    shieldNoir,
    shieldBackend,
    transferNoir,
    transferBackend,
    unshieldNoir,
    unshieldBackend,
    unshieldBundledNoir,
    unshieldBundledBackend,
  } = await getNoirClasses();

  const tree = await getMerkleTree();

  return {
    pampalo,
    usdcDeployment,
    fourDecDeployment,
    shieldNoir,
    shieldBackend,
    transferNoir,
    transferBackend,
    unshieldNoir,
    unshieldBackend,
    unshieldBundledNoir,
    unshieldBundledBackend,
    Signers,
    tree,
    deployer1Secret,
    deployer2Secret,
  };
};

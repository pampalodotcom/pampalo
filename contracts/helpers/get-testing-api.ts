import { getNoirClasses } from "@/helpers/objects/get-noir-classes.js";
import { getMerkleTree } from "@/helpers/objects/poseidon-merkle-tree.js";
import PampaloModule from "@/ignition/modules/Pampalo.js";
import TokensModule from "@/ignition/modules/Tokens.js";
import { ETH_ADDRESS } from "@pampalo/shared/constants/tree";
import { ethers } from "ethers";
import hre from "hardhat";
import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// One-shot test fixture: deploys the Pampalo contract + verifier
// libraries, the token mocks (USDC, FourDEC), the prebuilt Poseidon2
// huff hasher, and a MockOracle for USDC + ETH registered as supported
// assets. Cap-aware tests can re-target the oracle prices or override
// per-address caps via FINANCE_MANAGER_ROLE (granted to Signers[0]).
//
// MockOracle defaults: 1 USDC = $1.00 (100 cents/unit), 1 ETH = $0.01
// (100 cents/unit at 18 decimals). The ETH default is deliberately
// low so the existing shield tests don't bump into the $100 default
// monthly cap; tests that exercise realistic cap behavior reset the
// price first.

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

  const poseidon2HuffFactory = new ethers.ContractFactory(
    [],
    Poseidon2HuffJson.bytecode,
    Signers[0],
  );
  const poseidon2Huff = await poseidon2HuffFactory.deploy();
  await poseidon2Huff.waitForDeployment();
  const poseidon2Address = await poseidon2Huff.getAddress();

  await pampalo.setPoseidon(poseidon2Address);

  // Oracles + supported-asset registration
  const MockOracleFactory = await connection.ethers.getContractFactory(
    "MockOracle",
  );
  const usdcOracle = (await MockOracleFactory.deploy(
    100n,
  )) as unknown as ethers.Contract;
  await usdcOracle.waitForDeployment();
  const ethOracle = (await MockOracleFactory.deploy(
    100n,
  )) as unknown as ethers.Contract;
  await ethOracle.waitForDeployment();

  await pampalo.addSupportedAsset(
    await usdcDeployment.getAddress(),
    await usdcOracle.getAddress(),
    6,
  );
  await pampalo.addSupportedAsset(ETH_ADDRESS, await ethOracle.getAddress(), 18);

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
    connection,
    pampalo,
    usdcDeployment,
    fourDecDeployment,
    usdcOracle,
    ethOracle,
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

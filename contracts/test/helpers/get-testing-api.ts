import hre from "hardhat";
import HelloWorldModule from "../../ignition/modules/HelloWorld.js";

// Lightweight test fixture in the shape of the larger project's
// `getTestingAPI`: one async call returns deployed contracts +
// signers so each test starts from a fresh, ready-to-use state.
//
// Currently only covers the HelloWorld smoke contract. When real
// contracts land:
//   - import their Ignition modules at the top,
//   - deploy them via `connection.ignition.deploy(Module)`,
//   - destructure the result and re-export from the return object.
// Anything else the suite needs across many tests (precomputed
// merkle trees, witness backends, etc.) should be built once here
// rather than per-test.

export async function getTestingAPI() {
  const connection = await hre.network.connect();
  const Signers = await connection.ethers.getSigners();

  const { helloWorld } = await connection.ignition.deploy(HelloWorldModule);

  return {
    connection,
    Signers,
    helloWorld,
  };
}

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Smallest possible Ignition module — single contract, no
// constructor args, no post-deploy wiring. Replace with real
// modules as the contract suite grows.
export default buildModule("HelloWorldModule", (m) => {
  const helloWorld = m.contract("HelloWorld");
  return { helloWorld };
});

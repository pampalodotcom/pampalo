/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import DepositVerifierModule from "./DepositVerifier.js";
import TransferVerifierModule from "./TransferVerifier.js";
import WithdrawVerifierModule from "./WithdrawVerifier.js";
import TransferExternalVerifierModule from "./TransferExternalVerifier.js";

// Pampalo's on-chain entrypoint. Deploys the four verifier contracts
// (each linked against its own ZKTranscriptLib) and the Pampalo
// contract itself, wiring the verifier addresses into the constructor.
// The Poseidon2 huff hasher is deployed separately (it ships as a
// prebuilt bytecode blob, not a Solidity contract) — see
// `helpers/get-testing-api.ts`.

const PampaloModule = buildModule("pampalo", (m) => {
  const { depositVerifier } = m.useModule(DepositVerifierModule);
  const { transferVerifier } = m.useModule(TransferVerifierModule);
  const { withdrawVerifier } = m.useModule(WithdrawVerifierModule);
  const { transferExternalVerifier } = m.useModule(
    TransferExternalVerifierModule,
  );

  const pampalo = m.contract("Pampalo", [
    depositVerifier,
    transferVerifier,
    withdrawVerifier,
    transferExternalVerifier,
  ]);

  return {
    pampalo,
    depositVerifier,
    transferVerifier,
    withdrawVerifier,
    transferExternalVerifier,
  };
});

export default PampaloModule;

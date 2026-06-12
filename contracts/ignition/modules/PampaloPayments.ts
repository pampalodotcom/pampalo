/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import PampaloModule from "./Pampalo.js";
import RedeemVerifierModule from "./RedeemVerifier.js";

// Deploys the PampaloPayments settlement singleton, wired to the live
// Pampalo deployment (for isKnownRoot) and a dedicated RedeemVerifier.
// Standalone from the Pampalo core -- it only reads roots, never writes.

const PampaloPaymentsModule = buildModule("pampaloPayments", (m) => {
  const { pampalo } = m.useModule(PampaloModule);
  const { redeemVerifier } = m.useModule(RedeemVerifierModule);

  const pampaloPayments = m.contract("PampaloPayments", [
    pampalo,
    redeemVerifier,
  ]);

  return {
    pampaloPayments,
    pampalo,
    redeemVerifier,
  };
});

export default PampaloPaymentsModule;

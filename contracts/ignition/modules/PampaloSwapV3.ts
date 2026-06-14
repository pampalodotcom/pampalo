/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import DepositVerifierModule from "./DepositVerifier.js";
import TransferVerifierModule from "./TransferVerifier.js";
import WithdrawVerifierModule from "./WithdrawVerifier.js";
import TransferExternalVerifierModule from "./TransferExternalVerifier.js";
import SwapVerifierModule from "./SwapVerifier.js";

// PampaloSwapV3 — the v3 venue superset of Pampalo (ADR 0017 clean-break:
// deploy this *instead of* Pampalo). Wires the four base verifiers plus
// the swap verifier, and the v3 SwapRouter02 address. Poseidon is set via
// setPoseidon post-deploy; addSupportedAsset (USDC/WETH + oracle) is a
// deploy-script step. The router address is supplied via the
// `SWAP_ROUTER` module parameter.

const PampaloSwapV3Module = buildModule("pampaloSwapV3", (m) => {
  const { depositVerifier } = m.useModule(DepositVerifierModule);
  const { transferVerifier } = m.useModule(TransferVerifierModule);
  const { withdrawVerifier } = m.useModule(WithdrawVerifierModule);
  const { transferExternalVerifier } = m.useModule(
    TransferExternalVerifierModule,
  );
  const { swapVerifier } = m.useModule(SwapVerifierModule);

  const swapRouter = m.getParameter("swapRouter");

  const pampalo = m.contract("PampaloSwapV3", [
    depositVerifier,
    transferVerifier,
    withdrawVerifier,
    transferExternalVerifier,
    swapRouter,
    swapVerifier,
  ]);

  return {
    pampalo,
    depositVerifier,
    transferVerifier,
    withdrawVerifier,
    transferExternalVerifier,
    swapVerifier,
  };
});

export default PampaloSwapV3Module;

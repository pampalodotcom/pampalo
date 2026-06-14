/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import DepositVerifierModule from "./DepositVerifier.js";
import TransferVerifierModule from "./TransferVerifier.js";
import WithdrawVerifierModule from "./WithdrawVerifier.js";
import TransferExternalVerifierModule from "./TransferExternalVerifier.js";
import SwapVerifierModule from "./SwapVerifier.js";

// PampaloSwapV4 — the v4 venue superset of Pampalo (ADR 0017 clean-break:
// deploy this *instead of* Pampalo). Wires the four base verifiers plus
// the swap verifier, and the v4 PoolManager address. Poseidon is set via
// setPoseidon post-deploy; addSupportedAsset (USDC/WETH + oracle) is a
// deploy-script step. The PoolManager address is supplied via the
// `POOL_MANAGER` module parameter.

const PampaloSwapV4Module = buildModule("pampaloSwapV4", (m) => {
  const { depositVerifier } = m.useModule(DepositVerifierModule);
  const { transferVerifier } = m.useModule(TransferVerifierModule);
  const { withdrawVerifier } = m.useModule(WithdrawVerifierModule);
  const { transferExternalVerifier } = m.useModule(
    TransferExternalVerifierModule,
  );
  const { swapVerifier } = m.useModule(SwapVerifierModule);

  const poolManager = m.getParameter("poolManager");

  const pampalo = m.contract("PampaloSwapV4", [
    depositVerifier,
    transferVerifier,
    withdrawVerifier,
    transferExternalVerifier,
    poolManager,
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

export default PampaloSwapV4Module;

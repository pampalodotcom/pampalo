/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SwapVerifierModule = buildModule("swapVerifier", (m) => {
  const swapVerifierZKTL = m.library(
    "contracts/verifiers/SwapVerifier.sol:ZKTranscriptLib",
    {
      id: "SwapVerifierLib",
    },
  );

  const swapVerifier = m.contract("SwapVerifier", [], {
    libraries: {
      ZKTranscriptLib: swapVerifierZKTL,
    },
  });

  return {
    swapVerifier,
    swapVerifierZKTL,
  };
});

export default SwapVerifierModule;

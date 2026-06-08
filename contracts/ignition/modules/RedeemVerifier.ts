/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const RedeemVerifierModule = buildModule("redeemVerifier", (m) => {
  const redeemVerifierZKTL = m.library(
    "contracts/verifiers/RedeemVerifier.sol:ZKTranscriptLib",
    {
      id: "RedeemVerifierLib",
    },
  );

  const redeemVerifier = m.contract("RedeemVerifier", [], {
    libraries: {
      ZKTranscriptLib: redeemVerifierZKTL,
    },
  });

  return {
    redeemVerifier,
    redeemVerifierZKTL,
  };
});

export default RedeemVerifierModule;

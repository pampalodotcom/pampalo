/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Test-only token deployments. The 4-decimal mock proves the asset-
// decimals math works for assets that aren't 18-decimal or 6-decimal,
// which is the common-case audit blindspot.

const TokensModule = buildModule("tokens", (m) => {
  const usdcDeployment = m.contract("USDC");
  const fourDecDeployment = m.contract("FourDEC");

  return {
    usdcDeployment,
    fourDecDeployment,
  };
});

export default TokensModule;

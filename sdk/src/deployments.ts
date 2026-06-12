// Known Pampalo deployments. Lets the CLI default the router address,
// scan start block, and token catalog per chain so callers can just say
// `--chain 84532`. Mirrors the Convex `pampaloDeployments` catalog; kept
// as static config so the SDK needs no Convex connection (CONTEXT.md
// "Account transport").

import type { TokenRef } from "./account.js";

export type Deployment = {
  chainId: number;
  name: string;
  /** Lowercased Pampalo router address. */
  pampalo: string;
  /** Block the router was deployed at — sync starts here, not genesis. */
  fromBlock: number;
  /** false → notes are ECIES'd to the path-0 envelope key (Base Sepolia).
   *  true → to the isolated (slot 420) key. Sync trial-decrypts with both
   *  regardless, so this is informational. */
  separateDerivationKey: boolean;
  tokens: TokenRef[];
};

export const DEPLOYMENTS: Record<number, Deployment> = {
  84532: {
    chainId: 84532,
    name: "Base Sepolia",
    pampalo: "0x86cc802b2d5a9ef41194e68ed69eecc37adaaf59",
    fromBlock: 42746800,
    separateDerivationKey: false,
    tokens: [
      {
        address: "0x445b24Cf4Ac9AC20ecc417Ac41160Fdc8088520d",
        decimals: 6,
        symbol: "USDC",
      },
      {
        address: "0xd9954D447721e9dF218dDF668E8c5f92846CEEff",
        decimals: 4,
        symbol: "4DEC",
      },
    ],
  },
  8453: {
    chainId: 8453,
    name: "Base",
    // Deterministic CREATE address from the v2 deployer (nonce 0), so it
    // matches Base Sepolia. Verified live on-chain.
    pampalo: "0x86cc802b2d5a9ef41194e68ed69eecc37adaaf59",
    fromBlock: 47237162,
    // Mainnet identities use the isolated (slot-420) envelope key.
    separateDerivationKey: true,
    tokens: [
      {
        address: "0x445b24Cf4Ac9AC20ecc417Ac41160Fdc8088520d",
        decimals: 6,
        symbol: "USDC",
      },
      {
        address: "0xd9954D447721e9dF218dDF668E8c5f92846CEEff",
        decimals: 4,
        symbol: "4DEC",
      },
    ],
  },
};

export function getDeployment(chainId: number): Deployment {
  const d = DEPLOYMENTS[chainId];
  if (!d) {
    throw new Error(
      `no Pampalo deployment registered for chainId ${chainId} — pass deployment + fromBlock explicitly`,
    );
  }
  return d;
}

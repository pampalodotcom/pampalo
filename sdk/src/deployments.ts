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
    pampalo: "0x3e6dfc4c233486a44e26a548e191c839f069037f",
    fromBlock: 42126146,
    separateDerivationKey: false,
    tokens: [
      {
        address: "0x4Fc9cc04f2A8d6Ff360352C61A4bb36Ab262Ae01",
        decimals: 6,
        symbol: "USDC",
      },
      {
        address: "0x79422adD613c2963389101D220E029594Ac60A00",
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

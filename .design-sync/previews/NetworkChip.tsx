import { NetworkChip } from "pampalo";

export const Mainnets = () => (
  <div className="flex flex-wrap items-center gap-2">
    <NetworkChip network="eth" />
    <NetworkChip network="base" />
    <NetworkChip network="arb" />
  </div>
);

export const Testnets = () => (
  <div className="flex flex-wrap items-center gap-2">
    <NetworkChip network="sepolia" />
    <NetworkChip network="baseSepolia" />
  </div>
);

export const CustomLabel = () => (
  <div className="flex flex-wrap items-center gap-2">
    <NetworkChip network="base" label="Base · 8453" />
    <NetworkChip network="eth" label="Ethereum Mainnet" />
  </div>
);

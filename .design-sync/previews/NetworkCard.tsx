import { NetworkCard } from "pampalo";

const ethereum = {
  id: "net_eth_mainnet",
  chainId: 1,
  name: "Ethereum",
  tagline: "L1 · Settlement",
};

const base = {
  id: "net_base",
  chainId: 8453,
  name: "Base",
  tagline: "L2 · Lower fees",
};

const baseSepolia = {
  id: "net_base_sepolia",
  chainId: 84532,
  name: "Base Sepolia",
  tagline: "Testnet · Base",
};

export const Unselected = () => (
  <div style={{ width: 220 }}>
    <NetworkCard
      network={ethereum}
      selected={false}
      mode="public"
      onSelect={() => {}}
    />
  </div>
);

export const SelectedPublic = () => (
  <div style={{ width: 220 }}>
    <NetworkCard network={base} selected mode="public" onSelect={() => {}} />
  </div>
);

export const SelectedPrivate = () => (
  <div style={{ width: 220 }}>
    <NetworkCard network={base} selected mode="private" onSelect={() => {}} />
  </div>
);

export const GridPair = () => (
  <div
    style={{
      width: 460,
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12,
    }}
  >
    <NetworkCard
      network={ethereum}
      selected={false}
      mode="private"
      onSelect={() => {}}
    />
    <NetworkCard
      network={baseSepolia}
      selected
      mode="private"
      onSelect={() => {}}
    />
  </div>
);

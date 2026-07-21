import { AssetRow } from "pampalo";

const eth = {
  symbol: "ETH",
  name: "Ethereum",
  decimals: 18,
  priceUsd: 3184.2,
  publicWei: 750000000000000000n, // 0.75 ETH
  privateWei: 1250000000000000000n, // 1.25 ETH
  chainIds: [1, 8453],
};

const usdc = {
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  priceUsd: 1.0,
  publicWei: 1840500000n, // 1,840.50 USDC
  privateWei: 0n,
  chainIds: [8453],
};

export const Shieldable = () => (
  <div className="w-[760px]">
    <AssetRow asset={eth} shieldable onMove={() => {}} />
  </div>
);

export const StaticBalance = () => (
  <div className="w-[760px]">
    <AssetRow asset={usdc} />
  </div>
);

export const Loading = () => (
  <div className="w-[760px]">
    <AssetRow
      asset={{
        symbol: "AUDD",
        name: "AUDD",
        decimals: 6,
        priceUsd: null,
        publicWei: null,
        privateWei: null,
        chainIds: [8453],
      }}
    />
  </div>
);

export const ConfirmingOnChain = () => (
  <div className="w-[760px]">
    <AssetRow asset={eth} shieldable confirmingKind="shield" />
  </div>
);

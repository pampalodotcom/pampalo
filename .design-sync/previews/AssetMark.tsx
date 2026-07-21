import { AssetMark } from "pampalo";

export const KnownAssets = () => (
  <div className="flex items-center gap-4">
    <AssetMark symbol="ETH" />
    <AssetMark symbol="USDC" />
    <AssetMark symbol="AUDD" />
    <AssetMark symbol="LINK" />
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-4">
    <AssetMark symbol="USDC" size={24} />
    <AssetMark symbol="USDC" size={40} />
    <AssetMark symbol="USDC" size={56} />
  </div>
);

export const UnregisteredFallback = () => (
  <div className="flex items-center gap-4">
    <AssetMark symbol="WBTC" />
    <AssetMark symbol="DAI" size={56} />
  </div>
);

import { GasTierPicker } from "pampalo";

// Mainnet-ish figures: 14 gwei cached gas price, simple ETH transfer
// (21,000 units), swap (~185k units), ETH at $3,184.20.
const MAINNET_GAS_WEI = "14000000000"; // 14 gwei
const BASE_GAS_WEI = "52000000"; // 0.052 gwei — Base sits well under 1 gwei
const ETH_USD = 3184.2;

export const InlineTransferMainnet = () => (
  <div style={{ width: 420 }}>
    <GasTierPicker
      tier="standard"
      onTierChange={() => {}}
      gasPriceWei={MAINNET_GAS_WEI}
      gasUnits={21000n}
      ethUsdPrice={ETH_USD}
    />
  </div>
);

export const InlineSwapBase = () => (
  <div style={{ width: 420 }}>
    <GasTierPicker
      tier="faster"
      onTierChange={() => {}}
      gasPriceWei={BASE_GAS_WEI}
      gasUnits={185000n}
      ethUsdPrice={ETH_USD}
    />
  </div>
);

export const CollapsedSummary = () => (
  <div style={{ width: 420 }}>
    <GasTierPicker
      tier="standard"
      onTierChange={() => {}}
      open={false}
      onToggle={() => {}}
      gasPriceWei={MAINNET_GAS_WEI}
      gasUnits={21000n}
      ethUsdPrice={ETH_USD}
    />
  </div>
);

export const ExpandedStupidFast = () => (
  <div style={{ width: 420 }}>
    <GasTierPicker
      tier="stupid"
      onTierChange={() => {}}
      open={true}
      onToggle={() => {}}
      gasPriceWei={MAINNET_GAS_WEI}
      gasUnits={185000n}
      ethUsdPrice={ETH_USD}
    />
  </div>
);

export const EstimatingGas = () => (
  <div style={{ width: 420 }}>
    <GasTierPicker
      tier="standard"
      onTierChange={() => {}}
      gasPriceWei={null}
      gasUnits={null}
      ethUsdPrice={null}
    />
  </div>
);

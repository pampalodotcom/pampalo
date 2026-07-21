import { NetworkFilterTabs } from "pampalo";

const options = [
  { value: "all" as const, label: "All networks" },
  { value: 1, label: "Ethereum" },
  { value: 8453, label: "Base" },
];

const testnetOptions = [
  { value: "all" as const, label: "All networks" },
  { value: 1, label: "Ethereum" },
  { value: 8453, label: "Base" },
  { value: 84532, label: "Base Sepolia" },
];

export const TabsAllSelected = () => (
  <NetworkFilterTabs value="all" options={options} onChange={() => {}} />
);

export const TabsBaseSelected = () => (
  <NetworkFilterTabs value={8453} options={options} onChange={() => {}} />
);

export const BadgesEthereumSelected = () => (
  <div style={{ width: 420 }}>
    <NetworkFilterTabs
      appearance="badges"
      value={1}
      options={testnetOptions}
      onChange={() => {}}
    />
  </div>
);

export const BadgesWrappingNarrow = () => (
  <div style={{ width: 240 }}>
    <NetworkFilterTabs
      appearance="badges"
      value={84532}
      options={testnetOptions}
      onChange={() => {}}
    />
  </div>
);

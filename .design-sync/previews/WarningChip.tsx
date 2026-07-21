import { WarningChip } from "pampalo";

export const Default = () => <WarningChip />;

export const WalletWarnings = () => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
    <WarningChip>Unshielding reveals this amount publicly</WarningChip>
    <WarningChip>Back up your recovery phrase before depositing</WarningChip>
    <WarningChip>Base Sepolia — testnet funds only</WarningChip>
  </div>
);

import { PrimaryButton, SecondaryButton } from "pampalo";
import { QrCode } from "lucide-react";

export const Default = () => (
  <div style={{ width: 360 }}>
    <SecondaryButton>Restore existing wallet</SecondaryButton>
  </div>
);

export const WithIcon = () => (
  <div style={{ width: 360 }}>
    <SecondaryButton>
      <QrCode className="size-4" />
      Show QR code
    </SecondaryButton>
  </div>
);

export const Disabled = () => (
  <div style={{ width: 360 }}>
    <SecondaryButton disabled>Cancel</SecondaryButton>
  </div>
);

export const PairedWithPrimary = () => (
  <div className="flex flex-col gap-3" style={{ width: 360 }}>
    <PrimaryButton>Create wallet</PrimaryButton>
    <SecondaryButton>Restore existing wallet</SecondaryButton>
  </div>
);

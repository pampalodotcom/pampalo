import { QRCanvas } from "pampalo";

// Real-shaped payloads: an EIP-681 address URI and a longer receive
// code carrying the shielded identifiers next to the EVM address.

const ADDRESS_URI =
  "ethereum:0x8Ba1f109551bD432803012645Ac136ddd64DBA72@8453";

const RECEIVE_CODE =
  "pampalo:receive?addr=0x8Ba1f109551bD432803012645Ac136ddd64DBA72&chain=8453&env=0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";

export const AddressUri = () => <QRCanvas value={ADDRESS_URI} />;

export const ReceiveCodeLarge = () => (
  <QRCanvas value={RECEIVE_CODE} size={224} />
);

export const CompactSize = () => <QRCanvas value={ADDRESS_URI} size={120} />;

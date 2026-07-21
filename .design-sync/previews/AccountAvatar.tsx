import { AccountAvatar } from "pampalo";

export const Sizes = () => (
  <div className="flex items-center gap-4">
    <AccountAvatar
      address="0x7C3a9F0b51De624A8C4c1b5f9D2e83B06A5d41C9"
      size={24}
    />
    <AccountAvatar
      address="0x7C3a9F0b51De624A8C4c1b5f9D2e83B06A5d41C9"
      size={40}
    />
    <AccountAvatar address="0x7C3a9F0b51De624A8C4c1b5f9D2e83B06A5d41C9" />
    <AccountAvatar
      address="0x7C3a9F0b51De624A8C4c1b5f9D2e83B06A5d41C9"
      size={72}
    />
  </div>
);

export const DistinctIdentities = () => (
  <div className="flex items-center gap-4">
    <AccountAvatar address="0x7C3a9F0b51De624A8C4c1b5f9D2e83B06A5d41C9" />
    <AccountAvatar address="0x9aE4c7B1f2E85dD0361b04FcA2571E3070b9C41a" />
    <AccountAvatar address="0x52a8D5D0E5F2fF08E2bB1D4C9E7a01B6D34c7e88" />
    <AccountAvatar address="0xB2c1D07E86a3D9F04Ff62B4E15a9c6db38214A55" />
  </div>
);

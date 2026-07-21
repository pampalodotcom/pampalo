import { ModeSegmented } from "pampalo";

export const PublicActive = () => (
  <div style={{ width: 340 }}>
    <ModeSegmented value="public" onChange={() => {}} />
  </div>
);

export const PrivateActive = () => (
  <div style={{ width: 340 }}>
    <ModeSegmented value="private" onChange={() => {}} />
  </div>
);

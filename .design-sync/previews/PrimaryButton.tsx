import { PrimaryButton } from "pampalo";
import { ArrowRight, Send } from "lucide-react";

export const Default = () => (
  <div style={{ width: 360 }}>
    <PrimaryButton>Create wallet</PrimaryButton>
  </div>
);

export const WithIcon = () => (
  <div style={{ width: 360 }}>
    <PrimaryButton>
      Continue
      <ArrowRight className="size-4" />
    </PrimaryButton>
  </div>
);

export const ConfirmSend = () => (
  <div style={{ width: 360 }}>
    <PrimaryButton>
      <Send className="size-4" />
      Send 0.25 ETH
    </PrimaryButton>
  </div>
);

export const Disabled = () => (
  <div style={{ width: 360 }}>
    <PrimaryButton disabled>Confirm &amp; Send</PrimaryButton>
  </div>
);

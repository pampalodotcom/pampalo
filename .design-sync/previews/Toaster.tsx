import * as React from "react";
import { Toaster, toast } from "pampalo";

export const ShieldConfirmed = () => {
  React.useEffect(() => {
    toast.success("Shield confirmed", {
      description: "0.5 ETH is now in your shielded balance on Ethereum.",
      duration: Infinity,
    });
  }, []);

  return <Toaster position="top-left" offset={16} />;
};

export const DepositDetected = () => {
  React.useEffect(() => {
    toast("Deposit detected", {
      description: "250.00 USDC arrived at 0x8f3C…9aD1 on Base.",
      duration: Infinity,
      action: {
        label: "Shield now",
        onClick: () => {},
      },
    });
  }, []);

  return <Toaster position="top-left" offset={16} />;
};

export const StatusStack = () => {
  React.useEffect(() => {
    toast.error("Unshield failed", {
      description: "The Base transaction reverted. No funds moved.",
      duration: Infinity,
    });
    toast.warning("Fees are elevated on Ethereum", {
      duration: Infinity,
    });
    toast.info("New address generated for this deposit", {
      duration: Infinity,
    });
  }, []);

  return <Toaster position="top-left" offset={16} expand />;
};

export const SendingLoading = () => {
  React.useEffect(() => {
    toast.loading("Sending 250.00 USDC…", {
      description: "Waiting for confirmation on Base.",
      duration: Infinity,
    });
  }, []);

  return <Toaster position="top-left" offset={16} />;
};

import { QrCode } from "lucide-react";
import { cn } from "@/lib/utils";

// Peer of DepositButton. Sits in the BalanceCard's primary-CTA row.
// Tinted with the private palette to signal the receive code carries
// shielded identifiers (envelope + poseidon) alongside the EVM
// address — distinguishes it from Deposit, which is the public/fiat
// onramp entrypoint.

export function ReceiveButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex w-full items-center justify-center gap-2",
        "h-[52px] rounded-full",
        "bg-[var(--priv)] text-[var(--paper)]",
        "font-semibold text-[15px]",
        "shadow-sm transition-transform duration-150",
        "hover:translate-y-[-1px] hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-3",
        "focus-visible:ring-[var(--priv-soft-2)]",
        className,
      )}
    >
      <QrCode className="size-4" />
      Receive
    </button>
  );
}

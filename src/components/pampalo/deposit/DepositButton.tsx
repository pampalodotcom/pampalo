import { ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/utils";

// Primary CTA inside the BalanceCard — full-width, public-orange
// gradient, drops the user into the Deposit sheet/dialog. Naming
// (per CONTEXT.md): label says "Deposit" because that's what users
// expect; the underlying flow is "Receive" + (eventually) Shield.

export function DepositButton({
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
        "bg-[var(--pub)] text-[var(--paper)]",
        "font-semibold text-[15px]",
        "shadow-sm transition-transform duration-150",
        "hover:translate-y-[-1px] hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-3",
        "focus-visible:ring-[var(--pub-soft-2)]",
        className,
      )}
    >
      <ArrowDownToLine className="size-4" />
      Deposit
    </button>
  );
}

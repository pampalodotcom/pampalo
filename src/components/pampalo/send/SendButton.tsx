import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

// Peer of DepositButton / ReceiveButton. Sits in the BalanceCard's
// primary-CTA stack, beneath Receive. Sea-teal lifted from the circular
// brand mark (the water band in pampalo-circular.svg) so Send reads as
// its own verb next to the public-orange Deposit and the private-green
// Receive.

export function SendButton({
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
        "bg-[#3a8a87] text-[var(--paper)]",
        "font-semibold text-[15px]",
        "shadow-sm transition-transform duration-150",
        "hover:translate-y-[-1px] hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-3",
        "focus-visible:ring-[#3a8a87]/30",
        className,
      )}
    >
      <Send className="size-4" />
      Send
    </button>
  );
}

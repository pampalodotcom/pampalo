import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DepositMode } from "./DepositSheet";
import { NetworkLogo } from "./NetworkLogo";

// One card in the network grid. Selected state tints the border + bg
// in the active mode's accent so the connection between the toggle and
// the card highlight reads from a glance.

export type NetworkChoice = {
  /** From supportedNetworks._id. Opaque to the card — used as a select key. */
  id: string;
  chainId: number;
  name: string;
  tagline: string;
  /** Optional — set by the Receive flow so the QR step can pick the
   *  matching envelope key (path-0 shared vs slot-420 isolated). Deposit
   *  callers don't populate this and the card itself doesn't care. */
  separateDerivationKey?: boolean;
};

export function NetworkCard({
  network,
  selected,
  mode,
  onSelect,
}: {
  network: NetworkChoice;
  selected: boolean;
  mode: DepositMode;
  onSelect: () => void;
}) {
  const accentClass =
    mode === "public" ? "border-[var(--pub)] bg-[var(--pub-soft)]" : "border-[var(--priv)] bg-[var(--priv-soft)]";
  const checkClass =
    mode === "public"
      ? "bg-[var(--pub)] text-[var(--paper)]"
      : "bg-[var(--priv)] text-[var(--paper)]";

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "relative flex min-h-[132px] flex-col items-start gap-3 rounded-2xl p-4 text-left",
        "border bg-paper-lo transition-colors",
        "hover:bg-[var(--paper-hi)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--pub-soft-2)]",
        selected ? accentClass : "border-line",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <NetworkLogo chainId={network.chainId} size={40} />
        {selected && (
          <span
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-full",
              checkClass,
            )}
            aria-hidden
          >
            <Check className="size-3.5" />
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="font-serif text-[17px] font-bold leading-tight text-ink">
          {network.name}
        </span>
        <span className="text-[12px] text-ink-mute">{network.tagline}</span>
      </div>
    </button>
  );
}

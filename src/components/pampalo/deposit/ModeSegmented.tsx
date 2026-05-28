import { cn } from "@/lib/utils";
import { SunIcon, MoonIcon } from "@/components/pampalo/SunMoonIcons";
import type { DepositMode } from "./DepositSheet";

// Two-segment Public/Private toggle with a sliding highlight that
// swaps tint with the active mode. Built as plain buttons so we don't
// pull in Radix's Tabs for two stateless options.

export function ModeSegmented({
  value,
  onChange,
}: {
  value: DepositMode;
  onChange: (mode: DepositMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Deposit destination"
      className="relative grid grid-cols-2 rounded-full bg-paper-lo p-1 border border-line"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full transition-[left,background] duration-200 ease-out",
          value === "public"
            ? "left-1 bg-[var(--pub-soft)]"
            : "left-[calc(50%+0.125rem)] bg-[var(--priv-soft)]",
        )}
      />
      <button
        type="button"
        role="radio"
        aria-checked={value === "public"}
        onClick={() => onChange("public")}
        className={cn(
          "relative z-10 inline-flex items-center justify-center gap-2 h-10 rounded-full text-[13px] font-semibold transition-colors",
          value === "public" ? "text-[var(--pub)]" : "text-ink-mute",
        )}
      >
        <SunIcon size={13} />
        Public
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "private"}
        onClick={() => onChange("private")}
        className={cn(
          "relative z-10 inline-flex items-center justify-center gap-2 h-10 rounded-full text-[13px] font-semibold transition-colors",
          value === "private" ? "text-[var(--priv)]" : "text-ink-mute",
        )}
      >
        <MoonIcon size={12} />
        Private
      </button>
    </div>
  );
}

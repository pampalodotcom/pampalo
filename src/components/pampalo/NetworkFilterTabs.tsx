import { cn } from "@/lib/utils";

export type NetworkFilter = "all" | number;

export type NetworkOption = {
  /** Either "all" or a chainId. */
  value: NetworkFilter;
  label: string;
};

/**
 * Pill-style tab group used above the assets list. Caller supplies the
 * list of chainIds (derived from `api.networks.list`) so the component
 * stays catalog-agnostic.
 */
export function NetworkFilterTabs({
  value,
  options,
  onChange,
  className,
}: {
  value: NetworkFilter;
  options: NetworkOption[];
  onChange: (value: NetworkFilter) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Network filter"
      className={cn(
        "inline-flex items-center gap-1 p-1 rounded-full",
        "bg-paper-lo border border-line",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "h-7 px-3 rounded-full",
              "text-[12.5px] font-semibold",
              "transition-colors",
              active
                ? "bg-card text-ink shadow-sm"
                : "text-ink-mute hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

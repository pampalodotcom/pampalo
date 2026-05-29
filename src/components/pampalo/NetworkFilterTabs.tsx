import { cn } from "@/lib/utils";
import { networkSlugForChainId, type NetworkSlug } from "./NetworkChip";

export type NetworkFilter = "all" | number;

export type NetworkOption = {
  /** Either "all" or a chainId. */
  value: NetworkFilter;
  label: string;
};

/** "tabs" = segmented pill control (desktop default); "badges" =
 *  individual rounded buttons that wrap and don't need a fixed-width
 *  container (better on narrow mobile where the segmented control
 *  competes with the section title for horizontal space). */
export type NetworkFilterAppearance = "tabs" | "badges";

const NET_DOT_COLOR: Record<NetworkSlug, string> = {
  eth: "#627EEA",
  base: "#0052FF",
  arb: "#28A0F0",
  sepolia: "#888888",
  baseSepolia: "#0052FF",
};

export function NetworkFilterTabs({
  value,
  options,
  onChange,
  className,
  appearance = "tabs",
}: {
  value: NetworkFilter;
  options: NetworkOption[];
  onChange: (value: NetworkFilter) => void;
  className?: string;
  appearance?: NetworkFilterAppearance;
}) {
  if (appearance === "badges") {
    return (
      <div
        role="group"
        aria-label="Network filter"
        className={cn("flex flex-wrap items-center gap-1.5", className)}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          const slug =
            typeof opt.value === "number"
              ? networkSlugForChainId(opt.value)
              : null;
          const dotColor = slug ? NET_DOT_COLOR[slug] : null;
          return (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5",
                "whitespace-nowrap text-[12px] font-semibold transition-colors",
                active
                  ? "bg-ink text-paper"
                  : "border border-line bg-transparent text-ink-soft hover:bg-paper-lo",
              )}
            >
              {dotColor && (
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: dotColor }}
                />
              )}
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label="Network filter"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 p-1 rounded-full",
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
              "whitespace-nowrap text-[12.5px] font-semibold",
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

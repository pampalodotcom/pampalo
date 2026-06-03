import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to day" : "Switch to night"}
      title={isDark ? "Switch to day" : "Switch to night"}
      className={cn(
        "inline-flex items-center gap-2 rounded-full",
        "border bg-card px-3 py-1.5",
        "text-[13px] font-semibold text-ink",
        "transition-colors hover:bg-paper-lo",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/40",
        className,
      )}
      style={{
        borderColor: isDark ? "rgba(255, 124, 77, 0.55)" : "var(--color-line)",
      }}
    >
      {isDark ? (
        <Moon className="size-4 text-ink" />
      ) : (
        <Sun className="size-4 text-[#FFD45E]" />
      )}
      {isDark ? "Night" : "Day"}
    </button>
  );
}

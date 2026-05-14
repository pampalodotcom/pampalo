import { cn } from "@/lib/utils";

export function StatusDot({
  label = "Signed in",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-shield"
        style={{ boxShadow: "0 0 0 3px rgba(28, 138, 94, 0.18)" }}
      />
      <span className="text-[11.5px] font-semibold text-ink-soft">{label}</span>
    </div>
  );
}

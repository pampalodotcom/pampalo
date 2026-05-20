import { cn } from "@/lib/utils";

export function BrandLockup({
  size = "md",
  className,
}: {
  /**
   * "md" → 28px mark + 22px wordmark (header chrome).
   * "sm" → 20px mark + 16px wordmark (footer chrome).
   */
  size?: "md" | "sm";
  className?: string;
}) {
  const isSm = size === "sm";
  return (
    <div className={cn("flex items-center gap-2 select-none", className)}>
      <img
        src="/pampalo-circular.svg"
        alt=""
        aria-hidden
        width={isSm ? 20 : 28}
        height={isSm ? 20 : 28}
        className={cn("shrink-0", isSm ? "h-5 w-5" : "h-7 w-7")}
        draggable={false}
      />
      <span
        className={cn(
          "font-serif font-semibold leading-none text-ink",
          isSm ? "text-[16px]" : "text-[22px]",
        )}
      >
        Pampalo
      </span>
    </div>
  );
}

import { cn } from "@/lib/utils";

export function BrandLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 select-none", className)}>
      <img
        src="/pampalo-circular.svg"
        alt=""
        aria-hidden
        width={28}
        height={28}
        className="h-7 w-7 shrink-0"
        draggable={false}
      />
      <span className="font-serif font-semibold text-[22px] leading-none text-ink">
        Pampalo
      </span>
    </div>
  );
}

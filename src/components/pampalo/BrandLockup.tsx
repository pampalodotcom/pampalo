import { cn } from "@/lib/utils";

export function BrandLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 select-none", className)}>
      <SunPalmMark className="h-7 w-7" />
      <span className="font-serif font-semibold text-[22px] leading-none text-ink">
        Pampalo
      </span>
    </div>
  );
}

function SunPalmMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="13" cy="13" r="8" fill="var(--color-sun)" />
      {/* Palm trunk */}
      <path
        d="M14 19c0-3.5 1.4-6.6 3.4-8.6"
        stroke="#5a3a1f"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* Palm fronds */}
      <path
        d="M17.4 10.4c1.6-1.4 3.6-1.8 5.4-1.2-1.4 1.6-3.4 2.4-5.4 1.2zM17.4 10.4c-.6-2 .2-4 1.6-5.4.8 2 .4 4.2-1.6 5.4zM17.4 10.4c2-.4 4 .4 5.4 2-2 .4-4-.4-5.4-2zM17.4 10.4c-1.8.8-3.6.4-5-1 1.4-1 3.2-1.2 5 1z"
        fill="#1a6b3c"
      />
    </svg>
  );
}

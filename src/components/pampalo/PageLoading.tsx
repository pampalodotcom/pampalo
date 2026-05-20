import { cn } from "@/lib/utils";

// Full-screen branded loading overlay, used to mask perceived latency during
// route transitions (sign-in → /wallet, register → /wallet, etc).
//
// Renders the dusk-coloured app icon pulsing in the centre on a paper-coloured
// background. Sits above all other content via `fixed inset-0 z-50`.

export function PageLoading({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "fixed inset-0 z-50 flex flex-col items-center justify-center",
        "bg-paper text-ink",
        "animate-[fade-in_240ms_ease-out_both]",
        className,
      )}
    >
      <img
        src="/pampalo-circular.svg"
        alt=""
        aria-hidden
        width={160}
        height={160}
        className="size-[160px] animate-[brand-pulse_1.6s_ease-in-out_infinite]"
        draggable={false}
      />
      {label && (
        <p className="mt-5 text-[13px] font-medium text-ink-soft">{label}</p>
      )}
    </div>
  );
}

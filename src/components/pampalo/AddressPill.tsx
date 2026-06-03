import { cn } from "@/lib/utils";

export function AddressPill({
  address,
  subline = "Ethereum Account",
  className,
}: {
  address: string;
  subline?: string;
  className?: string;
}) {
  const short = shortAddress(address);
  const gradient = avatarGradient(address);

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        aria-hidden
        className="size-11 shrink-0 rounded-full"
        style={{ background: gradient }}
      />
      <div className="min-w-0 flex flex-col">
        <span className="font-serif font-bold text-xl leading-tight text-ink">
          {short}
        </span>
        <span className="text-[11.5px] text-ink-mute leading-tight">
          {subline}
        </span>
      </div>
    </div>
  );
}

export function shortAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function avatarGradient(seed: string): string {
  // Simple deterministic gradient from address bytes. Real version would HSL-rotate
  // each stop based on the seed; for now this is stable per-address.
  const a = hash(seed, 0);
  const b = hash(seed, 7);
  const c = hash(seed, 13);
  return `conic-gradient(from ${a % 360}deg at 50% 50%, var(--color-accent) 0deg, var(--color-sun) ${(b % 180) + 90}deg, var(--color-sea) ${(c % 180) + 200}deg, var(--color-accent) 360deg)`;
}

function hash(s: string, salt: number): number {
  let h = salt | 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

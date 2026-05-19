import { cn } from "@/lib/utils";

// Brand-palette tones used to make the gradient feel like part of the
// Pampalo identity rather than a random colour wheel.
const PALETTE = [
  "#FFD45E", // sun
  "#FF7C4D", // pub-hi
  "#E8553A", // pub
  "#C44530", // umbrella red
  "#2BA974", // priv-hi
  "#1C8A5E", // priv
  "#2E7DC2", // calm blue (USDC mark)
  "#92BFDB", // sky
  "#FFE38A", // light sand
  "#0C2236", // ink
];

// Rolling hash over the address — deterministic, no crypto required.
function hashIdx(addr: string, offset: number): number {
  let h = 0;
  for (let i = offset; i < addr.length; i += 3) {
    h = (Math.imul(h, 31) + addr.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Round avatar with a deterministic conic gradient based on the EVM
 * address. Same address → same disc, so the user has a stable visual
 * identity even before we ship ENS.
 */
export function AccountAvatar({
  address,
  size = 56,
  className,
}: {
  address: string;
  size?: number;
  className?: string;
}) {
  const a = address.toLowerCase();
  const c1 = PALETTE[hashIdx(a, 2) % PALETTE.length];
  const c2 = PALETTE[hashIdx(a, 4) % PALETTE.length];
  const c3 = PALETTE[hashIdx(a, 6) % PALETTE.length];
  const angle = hashIdx(a, 0) % 360;
  return (
    <span
      className={cn("inline-block rounded-full shrink-0", className)}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(from ${angle}deg at 50% 50%, ${c1}, ${c2}, ${c3}, ${c1})`,
        boxShadow:
          "0 4px 12px rgba(12,34,54,0.18), inset 0 1px 0 rgba(255,255,255,0.18)",
      }}
      aria-hidden="true"
    />
  );
}

/** Truncated form: 0xABCD…WXYZ. */
export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

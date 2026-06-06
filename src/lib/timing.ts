// Tiny stopwatch for measuring sign-in / unlock pipelines.
//
// Usage:
//
//   const t = new Timing("sign-in");
//   t.mark("start /auth/authentication/start");
//   …
//   t.mark("WebAuthn get() resolved");
//   …
//   t.finish();
//
// Prints a collapsed console.group with per-step elapsed and totals.
// Gated by VITE_PAMPALO_TIMING — set it to "1" (or anything truthy) to enable.

const ENABLED = (() => {
  if (typeof window === "undefined") return false;
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> })
    .env?.VITE_PAMPALO_TIMING;
  // Also let users flip it from the console: `window.__pampaloTiming = true`.
  const fromWindow = (window as unknown as { __pampaloTiming?: boolean })
    .__pampaloTiming;
  return Boolean(fromEnv) || Boolean(fromWindow);
})();

export class Timing {
  private readonly start = performance.now();
  private prev = this.start;
  private readonly marks: Array<{
    label: string;
    sinceStart: number;
    sinceLast: number;
  }> = [];

  constructor(public readonly tag: string) {}

  mark(label: string): void {
    if (!ENABLED) return;
    const now = performance.now();
    this.marks.push({
      label,
      sinceStart: now - this.start,
      sinceLast: now - this.prev,
    });
    this.prev = now;
  }

  finish(extraTag?: string): void {
    if (!ENABLED) return;
    const total = performance.now() - this.start;
    const head = `[pampalo:timing] ${this.tag}${
      extraTag ? ` (${extraTag})` : ""
    } — ${total.toFixed(0)}ms total`;
    console.groupCollapsed(head);
    for (const m of this.marks) {
      console.log(
        `  +${m.sinceLast.toFixed(0).padStart(5)}ms  @${m.sinceStart
          .toFixed(0)
          .padStart(6)}ms   ${m.label}`,
      );
    }
    console.groupEnd();
  }
}

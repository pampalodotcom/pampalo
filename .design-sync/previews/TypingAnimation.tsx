import { TypingAnimation } from "pampalo";
import { Sparkles } from "lucide-react";

// Animation-driven: text types in over time, so screenshots catch a frame
// mid-animation. Previews use startOnView={false} plus fast typeSpeed so the
// full string is on screen within ~0.5s of mount.

export const SingleLine = () => (
  <TypingAnimation
    startOnView={false}
    duration={7}
    className="text-[15px] font-medium text-ink leading-snug tracking-normal"
  >
    Shield 0.42 ETH into your private balance
  </TypingAnimation>
);

// Mirrors the BalanceCard stale-balance nudge (Sparkles + cycling phrases).
// App uses typeSpeed 55; sped up here so the phrase is visible at capture.
export const BalanceNudge = () => (
  <div className="flex items-center gap-1.5">
    <Sparkles className="size-3 text-[var(--pub-hi)]" aria-hidden />
    <TypingAnimation
      words={[
        "Balances may have changed",
        "Sync to refresh private notes",
      ]}
      loop
      typeSpeed={10}
      deleteSpeed={6}
      pauseDelay={30000}
      cursorStyle="line"
      className="text-[11.5px] font-medium text-[var(--pub)] leading-snug tracking-normal"
    />
  </div>
);

// loop + long pauseDelay keeps the cursor visible once typing completes,
// so all three cursor styles stay on screen for the screenshot.
export const CursorStyles = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    {(
      [
        ["line", "8.4210 ETH on Ethereum"],
        ["block", "1,840.50 USDC on Base"],
        ["underscore", "Private balance synced"],
      ] as const
    ).map(([style, text]) => (
      <div
        key={style}
        style={{ display: "flex", alignItems: "baseline", gap: 12 }}
      >
        <TypingAnimation
          startOnView={false}
          duration={10}
          loop
          pauseDelay={60000}
          cursorStyle={style}
          words={[text]}
          className="font-mono text-[13.5px] font-semibold text-ink leading-snug tracking-normal"
        />
        <span style={{ fontSize: 11, color: "var(--color-ink-mute)" }}>
          cursorStyle="{style}"
        </span>
      </div>
    ))}
  </div>
);

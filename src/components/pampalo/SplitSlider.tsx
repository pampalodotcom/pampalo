import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SplitBar } from "./SplitBar";

// Controlled draggable variant of SplitBar. The user drags the handle
// along the public/private split to choose how much to shield (left)
// or unshield (right). The parent owns `pub` so it can compute the
// direction + delta for the Cancel/Confirm row.
//
// All events live on the track wrapper (pointer + keyboard); the
// handle has `pointer-events: none` so clicks-on-handle pass through
// and click-to-jump works. See the design build guide pasted in the
// initial spec.

type Props = {
  /** Current public balance, in display units (e.g. ETH, not wei). */
  pub: number;
  /** Sum of pub + priv. Fixed — the slider never changes the total. */
  total: number;
  /** Original (on-chain) public balance — defines the baseline tick. */
  originalPub: number;

  onChange: (newPub: number) => void;

  decimals: number;
  ticker: string;

  /**
   * Lower bound on `pub`. Defaults to 0. Pass when the shield-cap
   * forbids moving more than X tokens out of public.
   * Effective minimum: `clamp(minPub, 0, originalPub)`.
   */
  minPub?: number;
  /**
   * Upper bound on `pub`. Defaults to `total`. Pass when an
   * unshield-cap or similar bounds the other direction.
   * Effective maximum: `clamp(maxPub, originalPub, total)`.
   */
  maxPub?: number;

  height?: number;
  className?: string;
};

const HANDLE_PX = 22;

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Within 3% of `originalPub / total`? Snap exactly to original. */
function snapToOriginal(
  newPublic: number,
  originalPublic: number,
  total: number,
): number {
  if (total <= 0) return newPublic;
  const origPct = originalPublic / total;
  const newPct = newPublic / total;
  return Math.abs(newPct - origPct) < 0.03 ? originalPublic : newPublic;
}

export function SplitSlider({
  pub,
  total,
  originalPub,
  onChange,
  decimals,
  ticker,
  minPub,
  maxPub,
  height = 12,
  className,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const disabled = total <= 0;
  // Effective travel bounds. `pub` is clamped to [bottom, top] on every
  // change so cap-constrained drags can't sneak past via keyboard.
  const bottom = clamp(minPub ?? 0, 0, originalPub);
  const top = clamp(maxPub ?? total, originalPub, total);

  const safePub = clamp(pub, bottom, top);
  const priv = Math.max(0, total - safePub);
  const pubPct = total > 0 ? (safePub / total) * 100 : 0;
  const origPct = total > 0 ? (originalPub / total) * 100 : 0;
  const dirty = Math.abs(safePub - originalPub) > 1e-9;

  // ─── Pointer drag (mouse + touch) ─────────────────────────────────────
  const setFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
      const raw = pct * total;
      const snapped = snapToOriginal(raw, originalPub, total);
      onChange(clamp(snapped, bottom, top));
    },
    [bottom, onChange, originalPub, top, total],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      const track = trackRef.current;
      if (!track) return;
      track.setPointerCapture(e.pointerId);
      setDragging(true);
      setFromClientX(e.clientX);
    },
    [disabled, setFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setFromClientX(e.clientX);
    },
    [dragging, setFromClientX],
  );

  const endDrag = useCallback(() => {
    setDragging(false);
  }, []);

  // ─── Keyboard ─────────────────────────────────────────────────────────
  // arrow + Home/End. ←↓ = move toward private (reduce pub). →↑ = toward
  // public (increase pub). Shift = 5% steps.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || total <= 0) return;
      const stepPct = e.shiftKey ? 0.05 : 0.01;
      const step = stepPct * total;
      let next = safePub;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          next = safePub - step;
          break;
        case "ArrowRight":
        case "ArrowUp":
          next = safePub + step;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = total;
          break;
        default:
          return;
      }
      e.preventDefault();
      onChange(clamp(snapToOriginal(next, originalPub, total), bottom, top));
    },
    [bottom, disabled, onChange, originalPub, safePub, top, total],
  );

  // Reset internal drag flag if the parent yanks `pub` back to the
  // baseline (e.g. via Cancel) — the handle should release any
  // implicit capture state.
  useEffect(() => {
    if (!dragging) return;
    if (disabled) setDragging(false);
  }, [disabled, dragging]);

  const valueText = `${safePub.toFixed(decimals)} ${ticker} public, ${priv.toFixed(decimals)} ${ticker} private`;

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-disabled={disabled || undefined}
      aria-valuemin={bottom}
      aria-valuemax={top}
      aria-valuenow={safePub}
      aria-valuetext={valueText}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        "split-slider",
        disabled && "is-disabled",
        dragging && "is-dragging",
        className,
      )}
      style={{ height: HANDLE_PX + 24 /* +12px hit-pad each side */ }}
    >
      <div
        className="split-slider-bar-wrap"
        style={{ height }}
      >
        <SplitBar
          publicValue={safePub}
          privateValue={priv}
          height={height}
          hideDivider
        />
        {dirty && total > 0 && (
          <div
            className="split-slider-baseline"
            style={{ left: `${origPct}%` }}
            aria-hidden="true"
          />
        )}
        {!disabled && (
          <div
            className="split-slider-handle"
            style={{ left: `${pubPct}%` }}
            aria-hidden="true"
          >
            <span className="grip" />
            <span className="grip" />
          </div>
        )}
      </div>
    </div>
  );
}

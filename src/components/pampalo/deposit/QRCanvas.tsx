import { useEffect, useRef } from "react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";

// Minimal QR renderer — paints into a canvas via the `qrcode` package
// (used everywhere; small enough that the bundle hit is fine for a
// receive screen). Resolution is locked to `size` × DPR so the rendered
// QR stays crisp on retina without us having to expose size knobs
// throughout the tree.

export function QRCanvas({
  value,
  size = 168,
  className,
}: {
  value: string;
  /** CSS pixels. Backing store is multiplied by devicePixelRatio. */
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    void QRCode.toCanvas(canvas, value, {
      width: size * dpr,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#0a0a0a",
        light: "#ffffff",
      },
    }).then(() => {
      // The qrcode library writes `canvas.style.width/height` in device
      // pixels — so on a DPR-3 phone the canvas would render at 3× its
      // intended CSS size and blow out the layout. Pin the CSS
      // dimensions back to the requested size; the backing store stays
      // high-res for retina sharpness.
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    });
  }, [value, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{ width: `${size}px`, height: `${size}px` }}
      className={cn("block rounded-lg", className)}
      aria-hidden
    />
  );
}

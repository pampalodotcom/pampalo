import { cn } from "@/lib/utils";

type Props = {
  /** USD-weighted public value. Used purely for the bar geometry. */
  publicValue: number;
  /** USD-weighted private value. */
  privateValue: number;
  /** Bar height in px. Defaults to 10 to match the design handoff. */
  height?: number;
  /** Hide the divider line at the public/private boundary. */
  hideDivider?: boolean;
  className?: string;
};

/**
 * Two-tone bar showing the public/private split. Used inside the total
 * balance card, asset rows, and the move sheet's horizon viz. If both
 * inputs are 0 the bar renders neutral grey (the underlying `--line`
 * track) instead of a misleading 50/50 split.
 */
export function SplitBar({
  publicValue,
  privateValue,
  height = 10,
  hideDivider,
  className,
}: Props) {
  const total = publicValue + privateValue;
  const pubPct = total > 0 ? (publicValue / total) * 100 : 0;
  const privPct = total > 0 ? 100 - pubPct : 0;
  return (
    <div className={cn("split-bar", className)} style={{ height }}>
      <div className="pub-fill" style={{ width: `${pubPct}%` }} />
      <div className="priv-fill" style={{ width: `${privPct}%` }} />
      {!hideDivider && total > 0 && (
        <div className="divider" style={{ left: `${pubPct}%` }} />
      )}
    </div>
  );
}

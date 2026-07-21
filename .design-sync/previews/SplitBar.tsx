import type { ReactNode } from "react";
import { SplitBar } from "pampalo";

// USD-weighted public/private balances drive the bar geometry.

function Labeled({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ width: 640, display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="text-[12px] font-semibold text-ink-mute">{label}</span>
      {children}
    </div>
  );
}

export const MostlyPrivate = () => (
  <Labeled label="Public $1,204.10 / Private $4,730.55">
    <SplitBar publicValue={1204.1} privateValue={4730.55} />
  </Labeled>
);

export const EvenSplit = () => (
  <Labeled label="Public $2,500 / Private $2,500">
    <SplitBar publicValue={2500} privateValue={2500} />
  </Labeled>
);

export const AllPublic = () => (
  <Labeled label="Public $3,184.20 / Private $0">
    <SplitBar publicValue={3184.2} privateValue={0} />
  </Labeled>
);

export const EmptyNeutralTrack = () => (
  <Labeled label="No balance — neutral grey track">
    <SplitBar publicValue={0} privateValue={0} />
  </Labeled>
);

export const ThickNoDivider = () => (
  <Labeled label="height 16, divider hidden">
    <SplitBar publicValue={880} privateValue={2140} height={16} hideDivider />
  </Labeled>
);

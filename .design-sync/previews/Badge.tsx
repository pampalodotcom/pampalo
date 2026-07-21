import { Badge } from "pampalo";
import {
  CircleCheck,
  Clock3,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Badge>Shielded</Badge>
    <Badge variant="secondary">Public</Badge>
    <Badge variant="outline">Base</Badge>
    <Badge variant="ghost">Draft</Badge>
    <Badge variant="destructive">Failed</Badge>
    <Badge variant="link">View on explorer</Badge>
  </div>
);

export const TransactionStatuses = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Badge variant="secondary">
      <CircleCheck data-icon="inline-start" />
      Confirmed
    </Badge>
    <Badge variant="outline">
      <Clock3 data-icon="inline-start" />
      Pending
    </Badge>
    <Badge>
      <ShieldCheck data-icon="inline-start" />
      Shielding
    </Badge>
    <Badge variant="destructive">
      <TriangleAlert data-icon="inline-start" />
      Reverted
    </Badge>
  </div>
);

export const Networks = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Badge variant="outline">
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 9999,
          background: "#627eea",
        }}
      />
      Ethereum
    </Badge>
    <Badge variant="outline">
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 9999,
          background: "#0052ff",
        }}
      />
      Base
    </Badge>
  </div>
);

export const Assets = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Badge variant="secondary">ETH</Badge>
    <Badge variant="secondary">USDC</Badge>
    <Badge variant="secondary">AUDD</Badge>
  </div>
);

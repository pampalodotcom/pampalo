import * as React from "react";
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "pampalo";
import { ArrowUpRight } from "lucide-react";

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono">{value}</span>
  </div>
);

export const SendBottomSheet = () => (
  <Sheet open>
    <SheetContent side="bottom">
      <SheetHeader>
        <SheetTitle>Send USDC</SheetTitle>
        <SheetDescription>
          Sent from your shielded balance — the recipient only sees the
          incoming transfer.
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 px-5 py-4">
        <Row label="To" value="0x8f3C…9aD1" />
        <Row label="Amount" value="250.00 USDC" />
        <Row label="Network" value={<Badge variant="outline">Base</Badge>} />
        <Row label="Est. fee" value="0.18 USDC" />
        <Button className="mt-2 w-full">
          <ArrowUpRight data-icon="inline-start" />
          Review send
        </Button>
      </div>
    </SheetContent>
  </Sheet>
);

export const TransactionDetailSheet = () => (
  <Sheet open>
    <SheetContent side="right">
      <SheetHeader>
        <SheetTitle>Shield ETH</SheetTitle>
        <SheetDescription>Confirmed · 14 Jul 2026, 09:42</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 px-5 py-4">
        <Row label="Amount" value="0.5 ETH" />
        <Row label="From" value="0x8f3C…9aD1" />
        <Row label="Network" value="Ethereum" />
        <Row label="Fee" value="0.0021 ETH" />
        <Row
          label="Status"
          value={<Badge variant="secondary">Confirmed</Badge>}
        />
        <Button variant="outline" className="mt-2 w-full">
          View on explorer
        </Button>
      </div>
    </SheetContent>
  </Sheet>
);

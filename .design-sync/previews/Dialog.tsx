import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "pampalo";
import { ShieldCheck } from "lucide-react";

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono">{value}</span>
  </div>
);

export const ConfirmShield = () => (
  <Dialog open>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Shield 0.5 ETH</DialogTitle>
        <DialogDescription>
          Move 0.5 ETH from your public balance into your shielded balance.
          This submits an on-chain transaction.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Row label="From" value="0x8f3C…9aD1" />
        <Row label="Network" value="Ethereum" />
        <Row label="Est. fee" value="0.0021 ETH" />
      </div>
      <DialogFooter showCloseButton>
        <Button>
          <ShieldCheck data-icon="inline-start" />
          Shield ETH
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const UnshieldWarning = () => (
  <Dialog open>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Unshield 1,250.00 USDC</DialogTitle>
        <DialogDescription>
          This moves funds back to your public address on Base. The amount and
          destination become visible on-chain.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Row label="To" value="0x8f3C…9aD1" />
        <Row
          label="Network"
          value={<Badge variant="outline">Base</Badge>}
        />
        <Row label="Est. fee" value="0.42 USDC" />
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button variant="destructive">Unshield USDC</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

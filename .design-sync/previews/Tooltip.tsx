import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "pampalo";
import { ShieldCheck } from "lucide-react";

export const FullAddress = () => (
  <TooltipProvider>
    <div style={{ padding: "72px 32px 24px" }}>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" className="font-mono">
            0x8f3C…9aD1
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <span className="font-mono">
            0x8f3C42a7B19eD05c4F86eB21d34A90f2Ce619aD1
          </span>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

export const ShieldedExplainer = () => (
  <TooltipProvider>
    <div style={{ padding: "56px 32px 24px" }}>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="What is shielded?">
            <ShieldCheck />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Shielded balances stay private on-chain
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

export const FeeBreakdown = () => (
  <TooltipProvider>
    <div style={{ padding: "24px 32px 72px" }}>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">
            Est. fee 0.18 USDC
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Base network fee plus the shielded relayer fee
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

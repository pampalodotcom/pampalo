import { useEffect, useState } from "react";
import { QrCode } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { NetworkChoice } from "../deposit/NetworkCard";
import { ReceivePickStep } from "./ReceivePickStep";
import { ReceiveQRStep } from "./ReceiveQRStep";

// Receive sheet — mirrors DepositSheet's pick → display two-step shape
// but skips the public/private mode toggle. The QR encodes a single
// /share URL containing all three identifiers + the chainId.

type Step = "pick" | "qr";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// All address material (evm / envelope / envelopeIsolated / poseidon) is
// sourced inside ReceiveQRStep via useAuth, so this sheet stays a thin
// wrapper. The parent only needs to tell us when to open/close.

export function ReceiveSheet({ open, onOpenChange }: Props) {
  const isDesktop = useIsDesktop();

  const [step, setStep] = useState<Step>("pick");
  const [network, setNetwork] = useState<NetworkChoice | null>(null);

  useEffect(() => {
    if (!open) {
      setStep("pick");
      setNetwork(null);
    }
  }, [open]);

  const body = (
    <div className="flex flex-col">
      <header className="flex items-center justify-between px-5 pt-3 sm:px-6 sm:pt-4">
        <div className="inline-flex items-center gap-2">
          <span
            className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--priv-soft)] text-[var(--priv)]"
            aria-hidden
          >
            <QrCode className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Receive
          </span>
        </div>
      </header>

      {step === "pick" ? (
        <ReceivePickStep
          selectedNetworkId={network?.id ?? null}
          onSelectNetwork={setNetwork}
          onContinue={() => {
            if (network) setStep("qr");
          }}
        />
      ) : network ? (
        <ReceiveQRStep
          network={network}
          onBack={() => setStep("pick")}
        />
      ) : null}
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn("w-[440px] max-w-[calc(100%-2rem)] gap-0 p-0")}
        >
          <VisuallyHidden.Root>
            <DialogTitle>Receive</DialogTitle>
          </VisuallyHidden.Root>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-6">
        <VisuallyHidden.Root>
          <SheetTitle>Receive</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

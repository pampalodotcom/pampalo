import { useEffect, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { DepositPickStep } from "./DepositPickStep";
import { DepositReceiveStep } from "./DepositReceiveStep";
import type { NetworkChoice } from "./NetworkCard";

// Top-level Deposit sheet/dialog. Responsive primitive choice happens
// at the *wrapper* level so the body is identical between mobile and
// desktop — we don't pay a layout-divergence tax for what's the same
// flow.

export type DepositMode = "public" | "private";
export type DepositStep = "pick" | "receive";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receive address shown on step 2. Must be the user's EVM address. */
  address: string;
  /** Optional envelope public key — surfaced in the private-mode
   *  receive step's shareable URL so a future shield-to-others sender
   *  can derive the ECIES recipient. */
  envelope?: string;
  /** Optional Poseidon identifier — surfaced alongside the envelope
   *  in private-mode share URLs as the recipient note `owner`. */
  poseidon?: string;
};

export function DepositSheet({
  open,
  onOpenChange,
  address,
  envelope,
  poseidon,
}: Props) {
  const isDesktop = useIsDesktop();

  const [step, setStep] = useState<DepositStep>("pick");
  const [mode, setMode] = useState<DepositMode>("public");
  const [network, setNetwork] = useState<NetworkChoice | null>(null);

  // Reset step + network when the sheet closes, so re-opening starts
  // clean. Mode is *preserved* on close so a user who likes "Public" by
  // default doesn't have to re-toggle every time — but it'll be reset on
  // hard navigation anyway because this state lives in the wallet route.
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
            className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--pub-soft)] text-[var(--pub)]"
            aria-hidden
          >
            <ArrowDownToLine className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Deposit
          </span>
        </div>
        {/* Close button is supplied by the Sheet/Dialog wrapper */}
      </header>

      {step === "pick" ? (
        <DepositPickStep
          mode={mode}
          onModeChange={setMode}
          selectedNetworkId={network?.id ?? null}
          onSelectNetwork={setNetwork}
          onContinue={() => {
            if (network) setStep("receive");
          }}
        />
      ) : network ? (
        <DepositReceiveStep
          mode={mode}
          network={network}
          address={address}
          envelope={envelope}
          poseidon={poseidon}
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
            <DialogTitle>Deposit</DialogTitle>
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
          <SheetTitle>Deposit</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

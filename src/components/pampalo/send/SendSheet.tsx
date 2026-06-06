import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { SendPickStep } from "./SendPickStep";
import { SendComposeStep } from "./SendComposeStep";
import { SendReviewStep } from "./SendReviewStep";
import type { TokenPair } from "@/components/pampalo/AssetSelect";

// Three-step send flow. Mirrors the deposit sheet shape — same
// Sheet/Dialog responsive split, same in-sheet step routing.
//
// Demo scope (per TRANSFERS.md and the design-spec triage):
//   - PRIVATE mode does proof-gen → self-broadcast (no relayer yet).
//   - PUBLIC mode is intentionally minimal here — for the demo, route
//     users to the existing `SendModal` for polished public sends.
//     This sheet's public mode exists so the mode toggle isn't lying
//     in the UI; the recipient input + amount UX is just enough to
//     send ETH.
//   - Manual recipient inputs only (no contacts, no payment-code parser).

export type SendMode = "public" | "private";
export type SendStep = "pick" | "compose" | "review";
export type SendInputUnit = "token" | "usd";

export type SendRecipient =
  | { kind: "public"; address: string }
  | { kind: "private"; poseidon: string; envelope: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** User's EVM address — needed by self-broadcast path. */
  evmAddress: string;
  /** User's Poseidon (for "change-to-self" output on private transfers). */
  selfPoseidon: string;
  /** User's envelope pubkey (for ECIES change-output encryption). */
  selfEnvelopePubKey: string;
};

export function SendSheet({
  open,
  onOpenChange,
  evmAddress,
  selfPoseidon,
  selfEnvelopePubKey,
}: Props) {
  const isDesktop = useIsDesktop();

  const [step, setStep] = useState<SendStep>("pick");
  const [mode, setMode] = useState<SendMode>("public");
  const [chainId, setChainId] = useState<number | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [inputUnit, setInputUnit] = useState<SendInputUnit>("token");
  const [recipient, setRecipient] = useState<SendRecipient | null>(null);
  // Selected token for public mode (ETH / USDC / AUDD / …). Private
  // mode is locked to ETH for v1 (only ETH is currently shielded),
  // so this is unused in that branch.
  const [tokenPair, setTokenPair] = useState<TokenPair | null>(null);

  // Reset everything on close so re-opening starts fresh.
  useEffect(() => {
    if (!open) {
      setStep("pick");
      setChainId(null);
      setAmount("");
      setInputUnit("token");
      setRecipient(null);
      setTokenPair(null);
    }
  }, [open]);

  // Switching mode invalidates the recipient (a public 0x and a
  // private pair aren't interchangeable) and the selected token
  // (private mode is ETH-only).
  const onModeChange = (next: SendMode) => {
    if (next === mode) return;
    setMode(next);
    setRecipient(null);
    setTokenPair(null);
  };

  const accent = mode === "private" ? "priv" : "pub";

  const body = (
    <div className="flex flex-col min-w-0">
      <header className="flex items-center justify-between px-5 pt-3 sm:px-6 sm:pt-4">
        <div className="inline-flex items-center gap-2">
          <span
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-lg",
              accent === "priv"
                ? "bg-[var(--priv-soft)] text-[var(--priv)]"
                : "bg-[var(--pub-soft)] text-[var(--pub)]",
            )}
            aria-hidden
          >
            <Send className="size-4" />
          </span>
          <span className="font-serif text-[18px] font-bold text-ink">
            Send
          </span>
        </div>
      </header>

      {step === "pick" ? (
        <SendPickStep
          mode={mode}
          onModeChange={onModeChange}
          chainId={chainId}
          onChainChange={setChainId}
          onContinue={() => setStep("compose")}
        />
      ) : step === "compose" ? (
        <SendComposeStep
          mode={mode}
          chainId={chainId}
          evmAddress={evmAddress}
          amount={amount}
          onAmountChange={setAmount}
          inputUnit={inputUnit}
          onInputUnitChange={setInputUnit}
          recipient={recipient}
          onRecipientChange={setRecipient}
          tokenPair={tokenPair}
          onTokenPairChange={setTokenPair}
          onBack={() => setStep("pick")}
          onContinue={() => setStep("review")}
        />
      ) : (
        <SendReviewStep
          mode={mode}
          chainId={chainId}
          amount={amount}
          inputUnit={inputUnit}
          recipient={recipient}
          tokenPair={tokenPair}
          evmAddress={evmAddress}
          selfPoseidon={selfPoseidon}
          selfEnvelopePubKey={selfEnvelopePubKey}
          onBack={() => setStep("compose")}
          onClose={() => onOpenChange(false)}
        />
      )}
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            "w-full gap-0 p-0",
            // Force a consistent 460px width on desktop; shadcn's
            // default `sm:max-w-sm` (384px) otherwise caps us and
            // wider content (compose step) pushes the grid track out.
            "sm:!w-[460px] sm:!max-w-[460px]",
          )}
        >
          <VisuallyHidden.Root>
            <DialogTitle>Send</DialogTitle>
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
          <SheetTitle>Send</SheetTitle>
        </VisuallyHidden.Root>
        {body}
      </SheetContent>
    </Sheet>
  );
}

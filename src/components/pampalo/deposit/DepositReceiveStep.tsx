import { useState } from "react";
import {
  ChevronLeft,
  ChevronDown,
  Copy,
  AlertTriangle,
  Check,
  Share2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useClipboard } from "@/lib/use-clipboard";
import { NetworkLogo } from "./NetworkLogo";
import { QRCanvas } from "./QRCanvas";
import type { NetworkChoice } from "./NetworkCard";
import type { DepositMode } from "./DepositSheet";

// Step 2 — show the receive address + QR for the chosen network.
// Mode here is always "public" in v1 because the pick step disables
// Continue when mode is "private"; the prop is plumbed through so the
// future shielded variant can render its envelope/Poseidon details
// without a parallel component.

function truncate(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function DepositReceiveStep({
  mode,
  network,
  address,
  envelope,
  poseidon,
  onBack,
}: {
  mode: DepositMode;
  network: NetworkChoice;
  /** Full receive address. Truncated for display, copied in full. */
  address: string;
  /** Envelope public key — included in the share URL for private mode
   *  so a shield-to-others sender can recover the ECIES recipient. */
  envelope?: string;
  /** Poseidon identifier — same purpose, included as the future note
   *  `owner` for shield-to-others. */
  poseidon?: string;
  onBack: () => void;
}) {
  const { copied, copy } = useClipboard();
  const isPrivate = mode === "private";
  const [showFull, setShowFull] = useState(false);

  const onShareLink = async () => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    params.set("evm", address);
    // Private mode includes the shielded-receive identifiers so the
    // person on the other end has everything a future shield-to-others
    // sender will need. Public mode only carries the EVM address.
    if (isPrivate && envelope) params.set("envelope", envelope);
    if (isPrivate && poseidon) params.set("poseidon", poseidon);
    const url = `${window.location.origin}/share?${params.toString()}`;

    const payload: ShareData = {
      title: `Pampalo · ${isPrivate ? "Shielded" : "Public"} receive on ${network.name}`,
      text: `Send to my Pampalo wallet on ${network.name}`,
      url,
    };
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    // Fallback when no native share sheet — copy to clipboard.
    try {
      await navigator.clipboard.writeText(url);
      toast("Share link copied to clipboard.");
    } catch {
      toast.error("Couldn't share — copy the address manually.");
    }
  };

  return (
    <div className="flex flex-col gap-5 px-5 pt-2 pb-5 sm:px-6 sm:pt-3 sm:pb-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-ink-mute hover:text-ink"
      >
        <ChevronLeft className="size-4" /> Back
      </button>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="font-serif text-[22px] font-bold tracking-[-0.01em] text-ink">
          Send to this address
        </h2>
        <p className="text-[13px] text-ink-mute">
          Funds land in your{" "}
          <span
            className={cn(
              "font-semibold",
              isPrivate ? "text-[var(--priv)]" : "text-[var(--pub)]",
            )}
          >
            {isPrivate ? "shielded" : "public"}
          </span>{" "}
          balance on{" "}
          <span className="font-semibold text-ink">{network.name}</span>.
        </p>
      </div>

      <div className="flex justify-center">
        <div className="relative rounded-2xl bg-white p-3 shadow-sm">
          <QRCanvas value={address} size={168} />
          {/* Brand badge in the QR centre. The QR's "M" error correction
              tolerates ~15% obscured area, well above the badge's
              footprint, so the code still scans cleanly. */}
          <span
            className="absolute left-1/2 top-1/2 inline-flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white p-1 shadow-sm"
            aria-hidden
          >
            <img
              src="/pampalo-circular.svg"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-full"
              draggable={false}
            />
          </span>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-paper-lo">
        <div className="flex items-center gap-3 p-3">
          <NetworkLogo chainId={network.chainId} size={28} />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-mute">
              {network.name} · {isPrivate ? "Shielded" : "Public"}
            </p>
            {showFull ? (
              <p
                className="mt-0.5 break-all font-mono text-[12px] leading-snug text-ink select-all"
                title={address}
              >
                {address}
              </p>
            ) : (
              <p
                className="mt-0.5 truncate font-mono text-[13px] text-ink select-all"
                title={address}
              >
                {truncate(address)}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowFull((v) => !v)}
              aria-label={showFull ? "Hide full address" : "Show full address"}
              aria-expanded={showFull}
              title={showFull ? "Hide full address" : "Show full address"}
              className="inline-flex size-9 items-center justify-center rounded-full border border-line transition-colors hover:bg-paper"
            >
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-150",
                  showFull && "rotate-180",
                )}
              />
            </button>
            <button
              type="button"
              onClick={() => copy(address)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-line px-3 h-9 text-[12px] font-semibold",
                "transition-colors hover:bg-paper",
                copied && "border-[var(--pub)] text-[var(--pub)]",
              )}
            >
              {copied ? (
                <>
                  <Check className="size-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" /> Copy
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onShareLink}
        className={cn(
          "inline-flex items-center justify-center gap-2 h-11 rounded-full",
          "border border-line bg-card text-[13px] font-semibold text-ink",
          "transition-colors hover:bg-paper-lo",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
        )}
      >
        <Share2 className="size-4" />
        Share link
      </button>

      <div className="flex items-start gap-2.5 rounded-2xl bg-[color-mix(in_oklab,var(--pub-soft)_60%,transparent)] px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--pub)]" />
        <p className="text-[12.5px] leading-relaxed text-ink">
          Only send assets on <span className="font-semibold">{network.name}</span>.
          Funds sent on another network may be unrecoverable.
        </p>
      </div>
    </div>
  );
}

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

// Step 2 — show the receive address + QR for the chosen network. In
// private mode the address well also surfaces the envelope + Poseidon
// identifiers so the user can copy each independently and the share
// link carries everything a future shield-to-others sender will need.

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
  const isPrivate = mode === "private";
  const [showFull, setShowFull] = useState(false);
  const { copied: urlCopied, copy: copyUrl } = useClipboard();

  // Build the canonical share URL once per render. The Share link
  // button (Web Share API) and the explicit Copy URL button both use
  // it so they can never drift.
  const buildShareUrl = (): string | null => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams();
    params.set("evm", address);
    // The chainId is always carried — it pins the receive surface to a
    // specific network so the recipient can't accidentally send on the
    // wrong chain after scanning the QR.
    params.set("chainId", String(network.chainId));
    // Private mode includes the shielded-receive identifiers so the
    // person on the other end has everything a future shield-to-others
    // sender will need. Public mode only carries the EVM address.
    if (isPrivate && envelope) params.set("envelope", envelope);
    if (isPrivate && poseidon) params.set("poseidon", poseidon);
    return `${window.location.origin}/share?${params.toString()}`;
  };

  const onCopyUrl = async () => {
    const url = buildShareUrl();
    if (!url) return;
    await copyUrl(url);
  };

  const onShareLink = async () => {
    const url = buildShareUrl();
    if (!url) return;

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

      <div className="flex flex-col items-center gap-2.5">
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
        <button
          type="button"
          onClick={onCopyUrl}
          aria-label="Copy share URL"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full",
            "border border-line bg-card px-3 h-8 text-[12px] font-semibold",
            "transition-colors hover:bg-paper-lo",
            urlCopied && "border-[var(--pub)] text-[var(--pub)]",
          )}
        >
          {urlCopied ? (
            <>
              <Check className="size-3.5" /> URL copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy URL
            </>
          )}
        </button>
      </div>

      <div className="rounded-2xl border border-line bg-paper-lo">
        <div className="flex items-center gap-3 px-3 pt-3 pb-2">
          <NetworkLogo chainId={network.chainId} size={28} />
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-mute">
            {network.name} · {isPrivate ? "Shielded" : "Public"}
          </p>
        </div>
        <div className="flex flex-col">
          <AddressRow
            label="Ethereum"
            value={address}
            showFull={showFull}
            onToggleFull={() => setShowFull((v) => !v)}
          />
          {isPrivate && envelope && (
            <AddressRow label="Envelope" value={envelope} />
          )}
          {isPrivate && poseidon && (
            <AddressRow label="Private" value={poseidon} />
          )}
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

// One row inside the address well. Owns its own Copy state so the
// rows don't share a single "copied" beat. `onToggleFull` is only
// passed for the long EVM row; envelope + poseidon stay
// non-truncatable since they're displayed as wrap-anywhere text.
function AddressRow({
  label,
  value,
  showFull,
  onToggleFull,
}: {
  label: string;
  value: string;
  showFull?: boolean;
  onToggleFull?: () => void;
}) {
  const { copied, copy } = useClipboard();
  const display = showFull === false ? truncate(value) : value;
  return (
    <div className="flex items-center gap-3 border-t border-line px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
          {label}
        </p>
        <p
          className={cn(
            "mt-0.5 font-mono text-[12px] leading-snug text-ink select-all",
            showFull === false ? "truncate" : "break-all",
          )}
          title={value}
        >
          {display}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onToggleFull && (
          <button
            type="button"
            onClick={onToggleFull}
            aria-label={showFull ? "Hide full address" : "Show full address"}
            aria-expanded={showFull}
            title={showFull ? "Hide full address" : "Show full address"}
            className="inline-flex size-8 items-center justify-center rounded-full border border-line transition-colors hover:bg-paper"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-150",
                showFull && "rotate-180",
              )}
            />
          </button>
        )}
        <button
          type="button"
          onClick={() => copy(value)}
          aria-label={`Copy ${label} address`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 h-8 text-[11.5px] font-semibold",
            "transition-colors hover:bg-paper",
            copied && "border-[var(--pub)] text-[var(--pub)]",
          )}
        >
          {copied ? (
            <>
              <Check className="size-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" /> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Share2,
} from "lucide-react";
import { toast } from "sonner";
import { useClipboard } from "@/lib/use-clipboard";
import { cn } from "@/lib/utils";
import { NetworkLogo } from "../deposit/NetworkLogo";
import { QRCanvas } from "../deposit/QRCanvas";
import type { NetworkChoice } from "../deposit/NetworkCard";

// Step 2 of Receive — single QR carrying all three identifiers
// (evm + envelope + poseidon + chainId) plus the same trio rendered
// as copyable rows. The /share route on the other end already knows
// how to parse this triple so a Pampalo-to-Pampalo scan lands the
// recipient with everything a private *or* public sender would need.

function truncate(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ReceiveQRStep({
  network,
  evm,
  envelope,
  poseidon,
  onBack,
}: {
  network: NetworkChoice;
  evm: string;
  envelope: string;
  poseidon: string;
  onBack: () => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const { copied: urlCopied, copy: copyUrl } = useClipboard();

  const buildShareUrl = (): string | null => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams();
    // Short keys — the envelope public key alone is 132 hex chars, so
    // verbose param names push the QR up several version steps. See
    // /share validateSearch for the e/k/o/c mapping.
    params.set("e", evm);
    params.set("k", envelope);
    params.set("o", poseidon);
    params.set("c", String(network.chainId));
    return `${window.location.origin}/share?${params.toString()}`;
  };
  const shareUrl = buildShareUrl();

  const onCopyUrl = async () => {
    if (!shareUrl) return;
    await copyUrl(shareUrl);
  };

  const onShareLink = async () => {
    if (!shareUrl) return;
    const payload: ShareData = {
      title: `Pampalo · Receive on ${network.name}`,
      text: `Send to my Pampalo wallet on ${network.name}`,
      url: shareUrl,
    };
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast("Share link copied to clipboard.");
    } catch {
      toast.error("Couldn't share — copy an address manually.");
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
          Your receive code
        </h2>
        <p className="text-[13px] text-ink-mute">
          Scan to send to your wallet on{" "}
          <span className="font-semibold text-ink">{network.name}</span> —
          covers public and shielded transfers.
        </p>
      </div>

      <div className="flex flex-col items-center gap-2.5">
        <div className="relative rounded-2xl bg-white p-3 shadow-sm">
          {shareUrl && <QRCanvas value={shareUrl} size={196} />}
          {/* Brand badge in the QR centre. "M" error correction tolerates
              ~15% obscured area, well above the badge's footprint. */}
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
            urlCopied && "border-[var(--priv)] text-[var(--priv)]",
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
            {network.name}
          </p>
        </div>
        <div className="flex flex-col">
          <AddressRow
            label="EVM"
            value={evm}
            showFull={showFull}
            onToggleFull={() => setShowFull((v) => !v)}
          />
          <AddressRow label="Envelope" value={envelope} />
          <AddressRow label="Poseidon" value={poseidon} />
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

      {/* Privacy note. Unlike DepositReceiveStep's "private mode" share
          URL — which deliberately omits the EVM address to avoid linking
          the user's on-chain identity to their shielded one — this code
          intentionally carries all three. Flag it so the user knows. */}
      <div className="flex items-start gap-2.5 rounded-2xl bg-[color-mix(in_oklab,var(--priv-soft)_60%,transparent)] px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--priv)]" />
        <p className="text-[12.5px] leading-relaxed text-ink">
          This code includes your public + shielded addresses together.
          Anyone you share it with can link your EVM identity to your
          shielded identifiers.
        </p>
      </div>
    </div>
  );
}

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
            copied && "border-[var(--priv)] text-[var(--priv)]",
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

import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Copy, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import { AccountAvatar, shortAddress } from "@/components/pampalo/AccountAvatar";
import { AddressWell } from "@/components/pampalo/AddressWell";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { QRCanvas } from "@/components/pampalo/deposit/QRCanvas";
import { ThemeToggle } from "@/components/pampalo/ThemeToggle";
import { useClipboard } from "@/lib/use-clipboard";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Public, unauthenticated address-sharing surface. The user (or
// someone they shared a link with) can view + copy + re-share the
// EVM address, envelope public key, and Poseidon identifier carried
// in the query string. Mirrors /account's wallet section but
// drops the Export-Secret affordance.
//
// Usage:
//   /share?e=0xabc…  → just the EVM address
//   /share?e=0xabc…&k=0x04…&o=0x…  → all three
//
// All three fields are public material per AUTH.md §1, so encoding
// them in a query string is fine. The address-derivation logic on
// the wallet side guarantees the triple is consistent for a given
// mnemonic; this page just renders whatever the caller passed.
//
// Query keys are deliberately single-letter — the envelope public
// key alone is 132 hex chars, and longer key names push the QR up
// several version steps (the modal QR is uncomfortably dense above
// ~280 chars). Internal property names stay full-length for
// readability; the mapping happens in validateSearch.
//   e → evm address       k → envelope (ECIES key)
//   o → poseidon owner    c → chainId       l → label

type ShareSearch = {
  evm?: string;
  envelope?: string;
  poseidon?: string;
  /** Network the addresses live on. Drives the network logo/label
   *  shown next to the addresses so the recipient can't misread which
   *  chain to send on. */
  chainId?: number;
  /** Optional display label, e.g. "Ben's wallet". */
  label?: string;
};

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_LONG = /^0x[0-9a-fA-F]+$/;
const HEX_32BYTE = /^0x[0-9a-fA-F]{64}$/;

function validateSearch(input: Record<string, unknown>): ShareSearch {
  const out: ShareSearch = {};
  if (typeof input.e === "string" && HEX_ADDR.test(input.e)) {
    out.evm = input.e;
  }
  if (typeof input.k === "string" && HEX_LONG.test(input.k)) {
    out.envelope = input.k;
  }
  if (typeof input.o === "string" && HEX_32BYTE.test(input.o)) {
    out.poseidon = input.o;
  }
  if (input.c !== undefined) {
    const raw = typeof input.c === "number" ? input.c : Number(input.c);
    if (Number.isFinite(raw) && raw > 0 && Number.isInteger(raw)) {
      out.chainId = raw;
    }
  }
  if (typeof input.l === "string" && input.l.length <= 64) {
    out.label = input.l;
  }
  return out;
}

export const Route = createFileRoute("/share")({
  validateSearch,
  component: SharePage,
});

function SharePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { theme } = useTheme();

  const { copy, copied } = useClipboard();

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.href;
  }, []);

  const titleLine = useMemo(() => {
    if (search.label) return search.label;
    if (search.evm) return shortAddress(search.evm);
    return "Pampalo address";
  }, [search]);

  const onShare = async () => {
    if (typeof navigator === "undefined" || !shareUrl) return;
    const payload: ShareData = {
      title: `Pampalo · ${titleLine}`,
      text: search.evm
        ? `Pampalo address ${shortAddress(search.evm)}`
        : "Pampalo address",
      url: shareUrl,
    };
    // Use Web Share API where available — iOS + Android browsers
    // surface the system share sheet (Messages, Mail, AirDrop, etc).
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        return;
      } catch (e) {
        // AbortError (user cancelled) → silent. Other errors → fall
        // through to clipboard fallback below.
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    // Fallback for desktop / browsers without share API: copy the
    // current URL and tell the user.
    void copy(shareUrl);
    toast("Link copied — paste it wherever you want to share.");
  };

  const hasAnyAddress = Boolean(
    search.evm || search.envelope || search.poseidon,
  );

  return (
    <main className="phone-shell flex flex-1 flex-col">
      <div className="relative shrink-0 w-full">
        <BeachScene height={240} theme={theme} />
        <div className="absolute inset-x-0 top-6 z-10 pointer-events-none">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5">
            <button
              type="button"
              onClick={() => {
                if (window.history.length > 1) {
                  window.history.back();
                  return;
                }
                void navigate({ to: "/" });
              }}
              className={cn(
                "pointer-events-auto inline-flex items-center gap-1.5",
                "h-8 rounded-full border border-line bg-card px-3",
                "text-[12.5px] font-semibold text-ink",
                "transition-colors hover:bg-paper-lo",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
              )}
            >
              <ArrowLeft className="size-3.5" /> Back
            </button>
            <div className="pointer-events-auto">
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10 -mt-10 mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-[8vw] pb-12 sm:px-4">
        <section className="rise-in rounded-3xl card-cream px-5 py-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <p className="eyebrow">Shared Address</p>
          </div>

          {hasAnyAddress ? (
            <>
              {search.evm && (
                <div className="mb-5 flex items-center gap-3">
                  <AccountAvatar address={search.evm} size={56} />
                  <div className="min-w-0">
                    <div className="font-serif text-[28px] font-bold leading-tight text-ink truncate">
                      {titleLine}
                    </div>
                    <div className="text-[13px] text-ink-mute">
                      {search.label
                        ? shortAddress(search.evm)
                        : "Ethereum Account"}
                    </div>
                  </div>
                </div>
              )}

              {search.evm && (
                <div className="mb-5 flex justify-center">
                  <div className="rounded-2xl bg-card p-3">
                    <QRCanvas value={search.evm} size={196} />
                  </div>
                </div>
              )}

              {search.evm && (
                <LabeledAddress
                  label="Ethereum"
                  hint="Public on-chain address"
                  value={search.evm}
                />
              )}
              {search.envelope && (
                <LabeledAddress
                  label="Envelope"
                  hint="Note encryption (secp256k1 public key)"
                  value={search.envelope}
                  className={search.evm ? "mt-3" : undefined}
                />
              )}
              {search.poseidon && (
                <LabeledAddress
                  label="Private"
                  hint="Poseidon2 (ZK identity)"
                  value={search.poseidon}
                  className={
                    search.evm || search.envelope ? "mt-3" : undefined
                  }
                />
              )}

              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!search.evm) return;
                    void copy(search.evm);
                  }}
                  disabled={!search.evm}
                  className={cn(
                    "inline-flex items-center justify-center gap-2",
                    "rounded-full border border-line bg-card px-4 py-3",
                    "text-[13px] font-semibold text-ink",
                    "transition-colors hover:bg-paper-lo disabled:opacity-50",
                    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
                  )}
                >
                  {copied ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {copied ? "Copied!" : "Copy address"}
                </button>
                <button
                  type="button"
                  onClick={onShare}
                  className={cn(
                    "inline-flex items-center justify-center gap-2",
                    "rounded-full bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
                    "px-4 py-3 text-[13px] font-bold text-white shadow-sm",
                    "transition-opacity hover:opacity-95",
                    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--priv-soft-2)]",
                  )}
                >
                  <Share2 className="size-4" />
                  Share link
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2 text-[13.5px] text-ink-soft">
              <p>No address details on this link.</p>
              <p className="text-[12px] text-ink-mute">
                The page expects at least an <code>evm</code> query parameter,
                e.g. <code>/share?evm=0xabc…</code>.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function LabeledAddress({
  label,
  hint,
  value,
  className,
}: {
  label: string;
  hint: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <p className="text-[11.5px] font-bold uppercase tracking-[0.1em] text-ink">
          {label}
        </p>
        <p className="text-[11px] text-ink-mute">{hint}</p>
      </div>
      <AddressWell address={value} />
    </div>
  );
}

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { ArrowUpRight, Check, Copy, Loader2, LogOut, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useTestnetsEnabled } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { AccountAvatar, shortAddress } from "./AccountAvatar";

/**
 * Bottom-anchored sheet on mobile, centred dialog on desktop. Triggered
 * via `useAccountModal().open()` from anywhere — see
 * `src/lib/account-modal.tsx`.
 */
export function AccountModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [testnets, setTestnets] = useTestnetsEnabled();
  const [signingOut, setSigningOut] = useState(false);
  const [copied, setCopied] = useState(false);

  const evm =
    auth.state.status === "authenticated"
      ? (auth.state.addresses?.evm ?? null)
      : null;

  function close() {
    onOpenChange(false);
  }

  function goToAccount() {
    close();
    void navigate({ to: "/account" });
  }

  async function onSignOut() {
    setSigningOut(true);
    try {
      await auth.signOut();
      close();
      toast("Signed out");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-out failed.";
      toast.error(msg);
    } finally {
      setSigningOut(false);
    }
  }

  async function onCopy() {
    if (!evm) return;
    try {
      await navigator.clipboard.writeText(evm);
      setCopied(true);
      toast("Address copied", { duration: 2000 });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn’t copy. Long-press to copy manually.");
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
            "w-[min(420px,calc(100vw-2rem))]",
            "rounded-3xl card-cream p-5 pt-4",
            "outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
          aria-describedby={undefined}
        >
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="eyebrow">Account</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-full",
                "border border-line bg-card text-ink",
                "transition-colors hover:bg-paper-lo",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
              )}
            >
              <X className="size-3.5" />
            </Dialog.Close>
          </div>

          {evm ? (
            <>
              <div className="flex items-center gap-3 mb-4">
                <AccountAvatar address={evm} size={48} />
                <div className="min-w-0 flex-1">
                  <div className="font-serif text-[20px] font-bold text-ink truncate">
                    {shortAddress(evm)}
                  </div>
                  <div className="text-[12px] text-ink-mute">
                    Ethereum Account
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onCopy}
                  aria-label="Copy address"
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full",
                    "border border-line bg-card px-3 py-1.5",
                    "text-[12px] font-semibold text-ink",
                    "transition-colors hover:bg-paper-lo",
                    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
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

              <button
                type="button"
                onClick={goToAccount}
                className={cn(
                  "w-full inline-flex items-center justify-between",
                  "rounded-2xl border border-line bg-paper-lo",
                  "px-4 py-3 mb-2 text-left",
                  "transition-colors hover:bg-card",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
                )}
              >
                <span className="flex flex-col">
                  <span className="text-[14px] font-semibold text-ink">
                    View account
                  </span>
                  <span className="text-[12px] text-ink-mute">
                    See all your keys + copy addresses
                  </span>
                </span>
                <ArrowUpRight className="size-4 text-ink-mute" />
              </button>
            </>
          ) : (
            <div className="mb-3 rounded-2xl border border-line bg-paper-lo px-4 py-3 text-[13px] text-ink-soft">
              Sign in to see your account details.
            </div>
          )}

          {/* Testnet toggle — session-scoped client preference. */}
          <label
            className={cn(
              "flex items-center justify-between gap-3",
              "rounded-2xl border border-line bg-paper-lo px-4 py-3 mb-2",
              "cursor-pointer select-none",
            )}
          >
            <span className="flex flex-col">
              <span className="text-[14px] font-semibold text-ink">
                Show testnets
              </span>
              <span className="text-[12px] text-ink-mute">
                Reveals Sepolia, Arbitrum Sepolia + Base Sepolia in the asset
                list.
              </span>
            </span>
            <Toggle
              checked={testnets}
              onChange={(v) => setTestnets(v)}
              ariaLabel="Toggle testnets"
            />
          </label>

          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className={cn(
              "w-full inline-flex items-center justify-center gap-2",
              "rounded-full border border-line bg-card",
              "px-4 py-3 text-[14px] font-semibold text-ink",
              "transition-colors hover:bg-paper-lo",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
              "disabled:opacity-50",
            )}
          >
            {signingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            Sign out
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Minimal switch — Radix has Switch but it's not in components/ui yet
// and this modal is the only consumer. Easy to swap later.
function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[24px] w-[42px] shrink-0 items-center",
        "rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
        checked
          ? "bg-[var(--priv)]"
          : "bg-[var(--color-line)] hover:bg-[color-mix(in_srgb,var(--color-line)_60%,var(--color-ink)_15%)]",
      )}
    >
      <span
        className={cn(
          "inline-block size-[18px] rounded-full bg-white shadow",
          "transition-transform",
          checked ? "translate-x-[21px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

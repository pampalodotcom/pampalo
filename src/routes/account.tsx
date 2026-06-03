import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, KeyRound, Loader2, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import {
  AccountAvatar,
  shortAddress,
} from "@/components/pampalo/AccountAvatar";
import { AddressWell } from "@/components/pampalo/AddressWell";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { MnemonicReveal } from "@/components/pampalo/MnemonicReveal";
import { PageLoading } from "@/components/pampalo/PageLoading";
import { ThemeToggle } from "@/components/pampalo/ThemeToggle";
import { exportMnemonic, PrfNotSupportedError } from "@/lib/auth-flow";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/account")({ component: AccountPage });

function AccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [reauthing, setReauthing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedMnemonic, setExportedMnemonic] = useState<string | null>(null);

  useEffect(() => {
    if (auth.state.status === "anonymous") {
      void navigate({ to: "/" });
    }
  }, [auth.state.status, navigate]);

  if (auth.state.status !== "authenticated") {
    return <PageLoading />;
  }

  const addresses = auth.state.addresses;

  async function onReAuth() {
    setReauthing(true);
    try {
      await auth.reAuth();
      toast("Wallet unlocked");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn’t unlock wallet.";
      toast.error(msg);
    } finally {
      setReauthing(false);
    }
  }

  async function onExportSecret() {
    setExporting(true);
    try {
      const m = await exportMnemonic();
      setExportedMnemonic(m);
    } catch (e) {
      if (e instanceof PrfNotSupportedError) {
        toast.error(e.message);
        return;
      }
      const msg =
        e instanceof Error ? e.message : "Couldn’t decrypt account secret.";
      toast.error(msg);
    } finally {
      setExporting(false);
    }
  }

  function onExportDismiss() {
    // Best-effort scrub — drop the reference so the GC can reclaim it.
    setExportedMnemonic(null);
  }

  return (
    <main className="phone-shell flex flex-1 flex-col">
      <div className="relative shrink-0 w-full">
        <BeachScene height={240} theme={theme} />
        <div className="absolute inset-x-0 top-6 z-10 pointer-events-none">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5">
            <button
              type="button"
              onClick={() => void navigate({ to: "/wallet" })}
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
        {exportedMnemonic && addresses ? (
          <section className="rise-in rounded-3xl card-cream px-5 py-5">
            <MnemonicReveal
              mode="export"
              mnemonic={exportedMnemonic}
              address={addresses.evm}
              onConfirmed={onExportDismiss}
            />
          </section>
        ) : (
          <section className="rise-in rounded-3xl card-cream px-5 py-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="eyebrow">Your Wallet</p>
              </div>
              {addresses && (
                <ReAuthButton onClick={onReAuth} loading={reauthing} />
              )}
            </div>

            {addresses ? (
              <>
                <div className="mb-5 flex items-center gap-3">
                  <AccountAvatar address={addresses.evm} size={56} />
                  <div className="min-w-0">
                    <div className="font-serif text-[28px] font-bold leading-tight text-ink">
                      {shortAddress(addresses.evm)}
                    </div>
                    <div className="text-[13px] text-ink-mute">
                      Ethereum Account
                    </div>
                  </div>
                </div>

                <LabeledAddress
                  label="Ethereum"
                  hint="Public on-chain address"
                  value={addresses.evm}
                />
                <LabeledAddress
                  label="Envelope"
                  hint="Note encryption (secp256k1 public key)"
                  value={addresses.envelope}
                  className="mt-3"
                />
                <LabeledAddress
                  label="Private"
                  hint="Poseidon2 (ZK identity)"
                  value={addresses.poseidon}
                  className="mt-3"
                />

                <button
                  type="button"
                  onClick={onExportSecret}
                  disabled={exporting}
                  className={cn(
                    "mt-5 inline-flex items-center justify-center gap-2",
                    "w-full rounded-full border border-line bg-card px-4 py-3",
                    "text-[13px] font-semibold text-ink",
                    "transition-colors hover:bg-paper-lo disabled:opacity-50",
                    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
                  )}
                >
                  {exporting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <KeyRound className="size-4" />
                  )}
                  {exporting ? "Unlocking…" : "Export Account Secret"}
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-3 text-[14px] text-ink-soft">
                <p>
                  Your wallet addresses aren’t cached on this device. Go back to
                  the wallet and unlock to see them.
                </p>
              </div>
            )}
          </section>
        )}
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

function ReAuthButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      aria-label="Unlock with passkey"
      title="Unlock with passkey"
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full",
        "border border-line bg-card text-ink",
        "transition-colors hover:bg-paper-lo",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
        "disabled:opacity-50",
      )}
    >
      {loading ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RefreshCcw className="size-3.5" />
      )}
    </button>
  );
}

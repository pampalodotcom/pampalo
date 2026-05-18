import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Fingerprint, KeyRound, RefreshCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AccountAvatar, shortAddress } from "@/components/pampalo/AccountAvatar";
import { AddressWell } from "@/components/pampalo/AddressWell";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { PageLoading } from "@/components/pampalo/PageLoading";
import { ThemeToggle } from "@/components/pampalo/ThemeToggle";
import { useAuth } from "@/lib/auth";
import { getBlob } from "@/lib/keystore";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/account")({ component: AccountPage });

function AccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [reauthing, setReauthing] = useState(false);

  useEffect(() => {
    if (auth.state.status === "anonymous") {
      void navigate({ to: "/" });
    }
  }, [auth.state.status, navigate]);

  if (auth.state.status !== "authenticated") {
    return <PageLoading />;
  }

  const addresses = auth.state.addresses;
  const scheme = getBlob()?.protectionScheme ?? "prf";

  async function onReAuth() {
    setReauthing(true);
    try {
      const outcome = await auth.reAuth();
      if (outcome.kind === "needs-passphrase") {
        toast("Passphrase unlock required — go back to /wallet to enter it.");
        return;
      }
      toast("Wallet unlocked");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn’t unlock wallet.";
      toast.error(msg);
    } finally {
      setReauthing(false);
    }
  }

  return (
    <main className="phone-shell flex min-h-dvh flex-col">
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

      <div className="relative z-10 -mt-10 mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pb-12">
        <section className="rise-in rounded-3xl card-cream px-5 py-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <p className="eyebrow">Your Wallet</p>
              <SchemeBadge scheme={scheme} />
            </div>
            {addresses && <ReAuthButton onClick={onReAuth} loading={reauthing} />}
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
                    Ethereum · Smart Account
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
            </>
          ) : (
            <div className="flex flex-col gap-3 text-[14px] text-ink-soft">
              <p>
                Your wallet addresses aren’t cached on this device. Go back
                to the wallet and unlock to see them.
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

function SchemeBadge({ scheme }: { scheme: "prf" | "passphrase" }) {
  const isPrf = scheme === "prf";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full",
        "border border-line bg-paper-lo px-2 py-0.5",
        "text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-soft",
      )}
      title={isPrf ? "Encrypted with passkey (PRF)" : "Encrypted with passphrase"}
    >
      {isPrf ? (
        <Fingerprint className="size-3" />
      ) : (
        <KeyRound className="size-3" />
      )}
      {isPrf ? "Passkey" : "Passphrase"}
    </span>
  );
}

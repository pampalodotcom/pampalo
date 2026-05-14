import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, LogOut, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { AddressPill } from "@/components/pampalo/AddressPill";
import { AddressWell } from "@/components/pampalo/AddressWell";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { SecondaryButton } from "@/components/pampalo/SecondaryButton";
import { useAuth } from "@/lib/auth";
import { getBlob } from "@/lib/keystore";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/wallet")({ component: Wallet });

function Wallet() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const [reauthing, setReauthing] = useState(false);

  useEffect(() => {
    if (auth.state.status === "anonymous") {
      void navigate({ to: "/" });
    }
  }, [auth.state.status, navigate]);

  if (auth.state.status !== "authenticated") {
    return (
      <main className="phone-shell flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-ink-mute" />
      </main>
    );
  }

  const addresses = auth.state.addresses;
  // We never keep the mnemonic in memory between signings — every tx
  // re-derives it via PRF. So the re-auth button is always available
  // when there's an address; the user taps it whenever they want to
  // re-unlock or refresh state.

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

  async function onSignOut() {
    setSigningOut(true);
    try {
      await auth.signOut();
      toast("Signed out");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-out failed.";
      toast.error(msg);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main className="phone-shell flex min-h-dvh flex-col">
      {/* Full-width beach band */}
      <div className="relative shrink-0 w-full">
        <BeachScene height={260} theme={theme} />
      </div>

      {/* Centered foreground column */}
      <div className="phone-column flex flex-1 flex-col">
        <section className="relative z-10 -mt-10 mx-4 rise-in rounded-3xl card-cream px-5 py-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="eyebrow">Your Wallet</p>
            {addresses && (
              <ReAuthButton onClick={onReAuth} loading={reauthing} />
            )}
          </div>

          {addresses ? (
            <>
              <AddressPill address={addresses.evm} className="mb-5" />

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
            <NoAddressNotice
              onUnlock={onReAuth}
              loading={reauthing}
              canReAuth={getBlob() !== null}
            />
          )}
        </section>

        <div className="mx-4 mt-auto mb-12">
          <SecondaryButton onClick={onSignOut} disabled={signingOut}>
            {signingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            Sign out
          </SecondaryButton>
        </div>
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
        "inline-flex size-7 items-center justify-center rounded-full",
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

function NoAddressNotice({
  onUnlock,
  loading,
  canReAuth,
}: {
  onUnlock: () => void;
  loading: boolean;
  canReAuth: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 text-[14px] text-ink-soft">
      <p>
        Your wallet addresses aren’t cached on this device. Unlock with your
        passkey to view them.
      </p>
      <button
        type="button"
        onClick={onUnlock}
        disabled={loading || !canReAuth}
        className={cn(
          "self-start inline-flex items-center gap-2 rounded-full",
          "border border-line bg-card px-3 py-2 text-[12.5px] font-semibold text-ink",
          "transition-colors hover:bg-paper-lo disabled:opacity-50",
        )}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCcw className="size-3.5" />
        )}
        Unlock with passkey
      </button>
    </div>
  );
}

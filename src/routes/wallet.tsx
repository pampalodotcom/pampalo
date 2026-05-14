import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fingerprint, KeyRound, Loader2, LogOut, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { AddressPill } from "@/components/pampalo/AddressPill";
import { AddressWell } from "@/components/pampalo/AddressWell";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { PageLoading } from "@/components/pampalo/PageLoading";
import { PassphraseEntry } from "@/components/pampalo/PassphraseEntry";
import { SecondaryButton } from "@/components/pampalo/SecondaryButton";
import { unlockWithPassphrase } from "@/lib/auth-flow";
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
  // Set when re-auth determines the wallet is passphrase-protected.
  // Switches the panel to a passphrase input rather than the address list.
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphraseBusy, setPassphraseBusy] = useState(false);

  useEffect(() => {
    if (auth.state.status === "anonymous") {
      void navigate({ to: "/" });
    }
  }, [auth.state.status, navigate]);

  if (auth.state.status !== "authenticated") {
    // While the cookie bootstrap resolves (or we're transitioning back to
    // anonymous on sign-out), show the same splash the Landing route does
    // — keeps the route swap perceptually seamless.
    return <PageLoading />;
  }

  const addresses = auth.state.addresses;
  // Surface the protection scheme so the user knows which credential they
  // hold. Defaults to 'prf' until the blob is bootstrapped.
  const scheme = getBlob()?.protectionScheme ?? "prf";

  async function onReAuth() {
    setReauthing(true);
    try {
      const outcome = await auth.reAuth();
      if (outcome.kind === "needs-passphrase") {
        setNeedsPassphrase(true);
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

  async function onPassphraseUnlock(passphrase: string) {
    setPassphraseBusy(true);
    try {
      await unlockWithPassphrase(passphrase);
      auth.refreshAddress();
      setNeedsPassphrase(false);
      toast("Wallet unlocked");
    } catch (e) {
      setPassphraseBusy(false);
      throw e;
    } finally {
      setPassphraseBusy(false);
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
          {needsPassphrase ? (
            <PassphraseEntry
              mode="unlock"
              onSubmit={onPassphraseUnlock}
              onBack={() => setNeedsPassphrase(false)}
              busy={passphraseBusy}
            />
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="eyebrow">Your Wallet</p>
                  <SchemeBadge scheme={scheme} />
                </div>
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
                  scheme={scheme}
                />
              )}
            </>
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
  scheme,
}: {
  onUnlock: () => void;
  loading: boolean;
  canReAuth: boolean;
  scheme: "prf" | "passphrase";
}) {
  const passphrase = scheme === "passphrase";
  return (
    <div className="flex flex-col gap-3 text-[14px] text-ink-soft">
      <p>
        Your wallet addresses aren’t cached on this device. Unlock{" "}
        {passphrase ? "with your passphrase" : "with your passkey"} to view
        them.
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
        {passphrase ? "Unlock with passphrase" : "Unlock with passkey"}
      </button>
    </div>
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

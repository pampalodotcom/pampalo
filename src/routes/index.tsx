import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fingerprint, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { BrandLockup } from "@/components/pampalo/BrandLockup";
import { MnemonicReveal } from "@/components/pampalo/MnemonicReveal";
import { PrimaryButton } from "@/components/pampalo/PrimaryButton";
import { SecondaryButton } from "@/components/pampalo/SecondaryButton";
import { WarningChip } from "@/components/pampalo/WarningChip";
import { useAuth } from "@/lib/auth";
import {
  completeConditionalSignIn,
  finalizeNewWallet,
  registerNewWallet,
  signInWithExistingPasskey,
  type NewWalletDraft,
} from "@/lib/auth-flow";
import {
  isConditionalUIAvailable,
  startConditionalGet,
} from "@/lib/passkey";
import { postJson } from "@/lib/http";

export const Route = createFileRoute("/")({ component: Landing });

type LocalUiState =
  | { kind: "idle" }
  | { kind: "registering" }
  | { kind: "signing-in" }
  | { kind: "reveal"; draft: NewWalletDraft };

function Landing() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [ui, setUi] = useState<LocalUiState>({ kind: "idle" });
  const conditionalAbortRef = useRef<AbortController | null>(null);

  // Already authenticated → bounce to /wallet.
  useEffect(() => {
    if (auth.state.status === "authenticated") {
      void navigate({ to: "/wallet" });
    }
  }, [auth.state.status, navigate]);

  // Conditional-mediation autofill ceremony, AUTH.md §6.5. Best-effort.
  useEffect(() => {
    if (auth.state.status !== "anonymous") return;
    const lifecycle = new AbortController();
    (async () => {
      try {
        if (!(await isConditionalUIAvailable())) return;
        const start = await postJson<
          Record<string, never>,
          { challenge: string; rpId: string }
        >("/auth/authentication/start", {});
        if (lifecycle.signal.aborted) return;

        const ceremony = new AbortController();
        conditionalAbortRef.current = ceremony;
        const { assertion } = await startConditionalGet({
          challenge: start.challenge,
          rpId: start.rpId,
          signal: ceremony.signal,
        });
        // TS narrows .aborted to false after the prior check; the lint
        // believes that, but it can flip mid-await.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (lifecycle.signal.aborted) return;

        const address = await completeConditionalSignIn(assertion);
        finalizeAddressIntoState(address);
        toast(`Signed in as ${shortAddress(address)}`);
        void navigate({ to: "/wallet" });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Conditional ceremony silently no-ops on most failures (no creds, etc).
      }
    })();
    return () => {
      lifecycle.abort();
      conditionalAbortRef.current?.abort();
      conditionalAbortRef.current = null;
    };
    // The conditional ceremony only needs to be re-armed when auth status
    // changes (e.g. after sign-out). React-hooks/exhaustive-deps isn't part
    // of the local config but the disable comment is harmless.
  }, [auth.state.status]);

  function finalizeAddressIntoState(_address: string) {
    auth.refreshAddress();
  }

  async function onSignIn() {
    conditionalAbortRef.current?.abort();
    setUi({ kind: "signing-in" });
    try {
      const address = await signInWithExistingPasskey();
      finalizeAddressIntoState(address);
      toast(`Signed in as ${shortAddress(address)}`);
      void navigate({ to: "/wallet" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed.";
      if (msg.toLowerCase().includes("not allowed")) {
        toast("No passkeys available on this device.");
      } else {
        toast.error(msg);
      }
      setUi({ kind: "idle" });
    }
  }

  async function onCreate() {
    conditionalAbortRef.current?.abort();
    setUi({ kind: "registering" });
    try {
      const draft = await registerNewWallet("My Pampalo wallet");
      setUi({ kind: "reveal", draft });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Wallet creation failed.";
      toast.error(msg);
      setUi({ kind: "idle" });
    }
  }

  function onMnemonicConfirmed() {
    if (ui.kind !== "reveal") return;
    finalizeNewWallet(ui.draft);
    finalizeAddressIntoState(ui.draft.address);
    void navigate({ to: "/wallet" });
  }

  const knownDevice =
    auth.state.status === "anonymous" ? auth.state.knownDevice : false;

  return (
    <main className="phone-shell flex min-h-dvh flex-col">
      {/* Beach scene with brand overlay */}
      <div className="relative shrink-0">
        <BeachScene height={420} />
        <div className="absolute left-6 top-12 z-10">
          <BrandLockup />
        </div>
      </div>

      {/* Hero card overlaps the scene's bottom fade */}
      <section
        className="relative z-10 -mt-10 mx-4 mb-8 rise-in rounded-3xl card-cream px-5 pt-6 pb-5"
      >
        {ui.kind === "reveal" ? (
          <MnemonicReveal
            mnemonic={ui.draft.mnemonic}
            address={ui.draft.address}
            onConfirmed={onMnemonicConfirmed}
          />
        ) : (
          <>
            <p className="eyebrow mb-3">Private · Passkey-Native</p>
            <h1 className="display-xl mb-4">
              Easy
              <br />
              Money.
            </h1>
            <p className="mb-5 text-[14.5px] leading-relaxed text-ink-soft">
              Pampalo uses passkey to secure your account credentials. We only
              store your encrypted data — that’s it.
            </p>

            <div className="flex flex-col gap-3">
              {knownDevice ? (
                <>
                  <PrimaryButton onClick={onSignIn} disabled={busy(ui)}>
                    {ui.kind === "signing-in" ? (
                      <Loader2 className="size-[18px] animate-spin" />
                    ) : (
                      <Fingerprint className="size-[18px]" />
                    )}
                    Sign in with Passkey
                  </PrimaryButton>
                  <SecondaryButton onClick={onCreate} disabled={busy(ui)}>
                    {ui.kind === "registering" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Get started (new wallet)
                  </SecondaryButton>
                </>
              ) : (
                <>
                  <PrimaryButton onClick={onCreate} disabled={busy(ui)}>
                    {ui.kind === "registering" ? (
                      <Loader2 className="size-[18px] animate-spin" />
                    ) : (
                      <Fingerprint className="size-[18px]" />
                    )}
                    Get started
                  </PrimaryButton>
                  <SecondaryButton onClick={onSignIn} disabled={busy(ui)}>
                    {ui.kind === "signing-in" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Fingerprint className="size-4" />
                    )}
                    I already have a passkey
                  </SecondaryButton>
                </>
              )}
            </div>

            <div className="mt-3">
              <WarningChip />
            </div>
          </>
        )}
      </section>

      <p className="mt-auto pb-6 text-center text-[11px] text-ink-mute">
        By continuing you agree to the{" "}
        <a href="#terms" className="underline">
          Terms
        </a>
      </p>

      {/* Anchor for conditional mediation autofill on browsers that need it. */}
      <input
        aria-hidden
        type="text"
        autoComplete="username webauthn"
        tabIndex={-1}
        className="sr-only"
      />
    </main>
  );
}

function busy(ui: LocalUiState): boolean {
  return ui.kind === "registering" || ui.kind === "signing-in";
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Fingerprint, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { BeachScene } from '@/components/pampalo/BeachScene'
import { BrandLockup } from '@/components/pampalo/BrandLockup'
import { MnemonicReveal } from '@/components/pampalo/MnemonicReveal'
import { PrimaryButton } from '@/components/pampalo/PrimaryButton'
import { ThemeToggle } from '@/components/pampalo/ThemeToggle'
import { WarningChip } from '@/components/pampalo/WarningChip'
import { useAuth } from '@/lib/auth'
import { useTheme } from '@/lib/theme'
import {
  completeConditionalSignIn,
  finalizeNewWallet,
  markMnemonicConfirmed,
  registerNewWallet,
  signInWithExistingPasskey,
  type NewWalletDraft,
} from '@/lib/auth-flow'
import { isConditionalUIAvailable, startConditionalGet } from '@/lib/passkey'
import { postJson } from '@/lib/http'

export const Route = createFileRoute('/')({ component: Landing })

type LocalUiState =
  | { kind: 'idle' }
  | { kind: 'registering' }
  | { kind: 'signing-in' }
  | { kind: 'reveal'; draft: NewWalletDraft }

function Landing() {
  const navigate = useNavigate()
  const auth = useAuth()
  const { theme } = useTheme()
  const [ui, setUi] = useState<LocalUiState>({ kind: 'idle' })
  const conditionalAbortRef = useRef<AbortController | null>(null)

  // Already authenticated → bounce to /wallet.
  useEffect(() => {
    if (auth.state.status === 'authenticated') {
      void navigate({ to: '/wallet' })
    }
  }, [auth.state.status, navigate])

  // Conditional-mediation autofill ceremony, AUTH.md §6.5. Best-effort.
  useEffect(() => {
    if (auth.state.status !== 'anonymous') return
    const lifecycle = new AbortController()
    ;(async () => {
      try {
        if (!(await isConditionalUIAvailable())) return
        const start = await postJson<
          Record<string, never>,
          { challenge: string; rpId: string }
        >('/auth/authentication/start', {})
        if (lifecycle.signal.aborted) return

        const ceremony = new AbortController()
        conditionalAbortRef.current = ceremony
        const { assertion } = await startConditionalGet({
          challenge: start.challenge,
          rpId: start.rpId,
          signal: ceremony.signal,
        })
        // TS narrows .aborted to false after the prior check; the lint
        // believes that, but it can flip mid-await.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (lifecycle.signal.aborted) return

        const address = await completeConditionalSignIn(assertion)
        finalizeAddressIntoState(address)
        toast(`Signed in as ${shortAddress(address)}`)
        void navigate({ to: '/wallet' })
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        // Conditional ceremony silently no-ops on most failures (no creds, etc).
      }
    })()
    return () => {
      lifecycle.abort()
      conditionalAbortRef.current?.abort()
      conditionalAbortRef.current = null
    }
    // The conditional ceremony only needs to be re-armed when auth status
    // changes (e.g. after sign-out). React-hooks/exhaustive-deps isn't part
    // of the local config but the disable comment is harmless.
  }, [auth.state.status])

  function finalizeAddressIntoState(_address: string) {
    auth.refreshAddress()
  }

  async function onSignIn() {
    conditionalAbortRef.current?.abort()
    setUi({ kind: 'signing-in' })
    try {
      const address = await signInWithExistingPasskey()
      finalizeAddressIntoState(address)
      toast(`Signed in as ${shortAddress(address)}`)
      void navigate({ to: '/wallet' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sign-in failed.'
      if (msg.toLowerCase().includes('not allowed')) {
        toast('No passkeys available on this device.')
      } else {
        toast.error(msg)
      }
      setUi({ kind: 'idle' })
    }
  }

  async function onCreate() {
    conditionalAbortRef.current?.abort()
    setUi({ kind: 'registering' })
    try {
      const draft = await registerNewWallet('My Pampalo wallet')
      setUi({ kind: 'reveal', draft })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Wallet creation failed.'
      toast.error(msg)
      setUi({ kind: 'idle' })
    }
  }

  function onMnemonicConfirmed() {
    if (ui.kind !== 'reveal') return
    const draft = ui.draft
    finalizeNewWallet(draft)
    finalizeAddressIntoState(draft.addresses.evm)
    // Fire-and-forget: nav to wallet immediately; the mutation runs in the
    // background. If it fails we surface a toast but don't block the UX.
    markMnemonicConfirmed(draft.sessionToken).catch((e: unknown) => {
      const msg =
        e instanceof Error ? e.message : 'Couldn’t save backup status.'
      toast.error(msg)
    })
    void navigate({ to: '/wallet' })
  }

  function onMnemonicSkipped() {
    if (ui.kind !== 'reveal') return
    finalizeNewWallet(ui.draft)
    finalizeAddressIntoState(ui.draft.addresses.evm)
    // No mutation — wallet.mnemonicConfirmedAt stays null on the server.
    void navigate({ to: '/wallet' })
  }

  const knownDevice =
    auth.state.status === 'anonymous' ? auth.state.knownDevice : false

  return (
    <main className="phone-shell flex min-h-dvh flex-col">
      {/* Full-width beach band; brand floats over it inside the centered column */}
      <div className="relative shrink-0 w-full">
        <BeachScene height={420} theme={theme} />
        <div className="absolute inset-x-0 top-12 z-10 pointer-events-none">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6">
            <div className="pointer-events-auto">
              <BrandLockup />
            </div>
            <div className="pointer-events-auto">
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>

      {/* Centered foreground column */}
      <div className="phone-column flex flex-1 flex-col">
        {/* Hero card overlaps the scene's bottom fade */}
        <section className="relative z-10 -mt-10 mx-4 mb-8 rise-in rounded-3xl card-cream px-5 pt-6 pb-5">
          {ui.kind === 'reveal' ? (
            <MnemonicReveal
              mnemonic={ui.draft.mnemonic}
              address={ui.draft.addresses.evm}
              onConfirmed={onMnemonicConfirmed}
              onSkip={onMnemonicSkipped}
            />
          ) : (
            <>
              <p className="eyebrow mb-3">Pampalo · Private Money</p>
              <h1 className="display-xl mb-4">
                Easy
                <br />
                Money.
              </h1>
              <p className="mb-5 text-[14.5px] leading-relaxed text-ink-soft">
                Pampalo uses passkey for your account, no passwords. Once you
                create your account, you can utilise the next generation of
                privacy enhancing financial technologies.
              </p>

              <div className="flex flex-col gap-3">
                {auth.state.status === 'loading' ? (
                  // Hold a neutral loading state until the cookie bootstrap
                  // resolves; otherwise the button label snaps from
                  // "Get started" to "Sign in with Passkey" on mount.
                  <PrimaryButton disabled aria-busy="true">
                    <Loader2 className="size-[18px] animate-spin" />
                    <span className="opacity-0">Sign in with Passkey</span>
                  </PrimaryButton>
                ) : knownDevice ? (
                  <PrimaryButton onClick={onSignIn} disabled={busy(ui)}>
                    {ui.kind === 'signing-in' ? (
                      <>
                        <Loader2 className="size-[18px] animate-spin" />
                        Signing in with Passkey…
                      </>
                    ) : (
                      <>
                        <Fingerprint className="size-[18px]" />
                        Sign in with Passkey
                      </>
                    )}
                  </PrimaryButton>
                ) : (
                  <>
                    <PrimaryButton onClick={onCreate} disabled={busy(ui)}>
                      {ui.kind === 'registering' ? (
                        <>
                          <Loader2 className="size-[18px] animate-spin" />
                          Registering passkey…
                        </>
                      ) : (
                        <>
                          <Fingerprint className="size-[18px]" />
                          Get started
                        </>
                      )}
                    </PrimaryButton>
                    {/* Cold-start escape hatch: on a new device the
                        `wallet_known_device` cookie isn't set, but a synced
                        passkey may already exist in the OS keychain. Without
                        this link the only option is "Get started", which
                        would create a duplicate wallet. */}
                    <button
                      type="button"
                      onClick={onSignIn}
                      disabled={busy(ui)}
                      className="self-center text-[13px] font-medium text-ink-mute underline underline-offset-2 hover:text-ink-soft disabled:opacity-50"
                    >
                      {ui.kind === 'signing-in'
                        ? 'Signing in with Passkey…'
                        : 'Already have a wallet? Sign in'}
                    </button>
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
          By continuing you agree to the{' '}
          <a
            href="/Pampalo-Terms-of-Service.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Terms and Conditions
          </a>
        </p>
      </div>

      {/* Anchor for conditional mediation autofill on browsers that need it. */}
      <input
        aria-hidden
        type="text"
        autoComplete="username webauthn"
        tabIndex={-1}
        className="sr-only"
      />
    </main>
  )
}

function busy(ui: LocalUiState): boolean {
  return ui.kind === 'registering' || ui.kind === 'signing-in'
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

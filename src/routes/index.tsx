import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Fingerprint, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { BeachScene } from '@/components/pampalo/BeachScene'
import { MnemonicReveal } from '@/components/pampalo/MnemonicReveal'
import { PageLoading } from '@/components/pampalo/PageLoading'
import { PrimaryButton } from '@/components/pampalo/PrimaryButton'
import { SecondaryButton } from '@/components/pampalo/SecondaryButton'
import { ThemeToggle } from '@/components/pampalo/ThemeToggle'
import { WarningChip } from '@/components/pampalo/WarningChip'
import { useAuth } from '@/lib/auth'
import { useTheme } from '@/lib/theme'
import {
  completeConditionalSignIn,
  finalizeNewWallet,
  PrfNotSupportedError,
  registerNewWallet,
  signInWithExistingPasskey,
  UnknownCredentialError,
  type NewWalletDraft,
} from '@/lib/auth-flow'
import { isConditionalUIAvailable, startConditionalGet } from '@/lib/passkey'
import { postJson } from '@/lib/http'

export const Route = createFileRoute('/')({ component: Landing })

type HelpKind = 'prf-not-supported' | 'unknown-credential'

type LocalUiState =
  | { kind: 'idle' }
  | { kind: 'registering' }
  | { kind: 'signing-in' }
  | { kind: 'reveal'; draft: NewWalletDraft }
  | { kind: 'help'; help: HelpKind }
  | { kind: 'transitioning' }

function Landing() {
  const navigate = useNavigate()
  const auth = useAuth()
  const { theme } = useTheme()
  const [ui, setUi] = useState<LocalUiState>({ kind: 'idle' })
  const conditionalAbortRef = useRef<AbortController | null>(null)

  // Already authenticated → bounce to /wallet.
  useEffect(() => {
    if (auth.state.status === 'authenticated') {
      setUi({ kind: 'transitioning' })
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

        const outcome = await completeConditionalSignIn(assertion)
        finalizeAddressIntoState(outcome.addresses.evm)
        toast(`Signed in as ${shortAddress(outcome.addresses.evm)}`)
        setUi({ kind: 'transitioning' })
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
      const outcome = await signInWithExistingPasskey()
      finalizeAddressIntoState(outcome.addresses.evm)
      toast(`Signed in as ${shortAddress(outcome.addresses.evm)}`)
      setUi({ kind: 'transitioning' })
      void navigate({ to: '/wallet' })
    } catch (e) {
      if (e instanceof PrfNotSupportedError) {
        setUi({ kind: 'help', help: 'prf-not-supported' })
        return
      }
      if (e instanceof UnknownCredentialError) {
        setUi({ kind: 'help', help: 'unknown-credential' })
        return
      }
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
      const draft = await registerNewWallet()
      setUi({ kind: 'reveal', draft })
    } catch (e) {
      if (e instanceof PrfNotSupportedError) {
        setUi({ kind: 'help', help: 'prf-not-supported' })
        return
      }
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
    setUi({ kind: 'transitioning' })
    void navigate({ to: '/wallet' })
  }

  function onMnemonicSkipped() {
    if (ui.kind !== 'reveal') return
    finalizeNewWallet(ui.draft)
    finalizeAddressIntoState(ui.draft.addresses.evm)
    setUi({ kind: 'transitioning' })
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
          <div className="mx-auto flex w-full max-w-7xl items-center justify-end px-6">
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
          ) : ui.kind === 'help' ? (
            <PasskeyHelp
              kind={ui.help}
              onBack={() => setUi({ kind: 'idle' })}
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
                Pampalo uses passkey PRF (Pseudo-Random Function) to encrypt
                and decrypt all application data.
              </p>
              <p className="mb-5 text-[14.5px] leading-relaxed text-ink-soft">
                Any data stored in the database is encrypted with (pass)keys
                that you control.{' '}
                <a
                  href="https://docs.pampalo.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-ink underline underline-offset-2 hover:text-ink-soft"
                >
                  Read More
                </a>
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

      </div>

      {/* Anchor for conditional mediation autofill on browsers that need it. */}
      <input
        aria-hidden
        type="text"
        autoComplete="username webauthn"
        tabIndex={-1}
        className="sr-only"
      />

      {ui.kind === 'transitioning' && <PageLoading />}
    </main>
  )
}

function busy(ui: LocalUiState): boolean {
  return ui.kind === 'registering' || ui.kind === 'signing-in'
}

function PasskeyHelp({
  kind,
  onBack,
}: {
  kind: HelpKind
  onBack: () => void
}) {
  const isPrf = kind === 'prf-not-supported'
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-warn-fg">
        <AlertTriangle className="size-4" />
        <p className="eyebrow" style={{ color: 'var(--color-warn-fg)' }}>
          Passkey can’t be used
        </p>
      </div>

      <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
        {isPrf
          ? 'Your passkey provider isn’t supported (yet)'
          : 'That passkey isn’t linked to a Pampalo wallet'}
      </h2>

      <p className="text-[14px] leading-relaxed text-ink-soft">
        {isPrf ? (
          <>
            Pampalo encrypts your wallet with a feature called the WebAuthn{' '}
            <em>PRF extension</em>. Apple Passwords (iCloud Keychain) and
            Google Password Manager support it. 1Password is still rolling
            out support and isn’t reliable yet — so we can’t use it.
          </>
        ) : (
          <>
            The passkey you picked exists on this device, but Pampalo doesn’t
            have a wallet linked to it. This usually happens when a previous
            account creation didn’t finish, or you picked a passkey from a
            different site.
          </>
        )}
      </p>

      {isPrf && (
        <div className="rounded-2xl bg-paper-lo border border-line px-3.5 py-3">
          <p className="mb-2 text-[12.5px] font-bold uppercase tracking-[0.1em] text-ink">
            On iPhone / iPad
          </p>
          <ol className="ml-4 list-decimal space-y-1.5 text-[13px] leading-relaxed text-ink-soft">
            <li>
              Open <strong>Settings → General → AutoFill &amp; Passwords</strong>
              .
            </li>
            <li>
              Make sure <strong>Passwords</strong> (Apple) is enabled.
            </li>
            <li>Disable 1Password as an AutoFill provider for now.</li>
            <li>Come back to Pampalo and tap Get started again.</li>
          </ol>
        </div>
      )}

      <SecondaryButton onClick={onBack}>
        <ArrowLeft className="size-4" />
        Back
      </SecondaryButton>
    </div>
  )
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

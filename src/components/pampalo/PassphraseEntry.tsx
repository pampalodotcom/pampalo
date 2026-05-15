// Passphrase entry UX for the non-PRF fallback path. Used in two modes:
//
// - 'setup'  → user is creating a wallet whose passkey provider doesn't
//              support PRF. Ask for the passphrase + a confirmation field.
// - 'unlock' → user is unlocking an existing passphrase-protected wallet.
//              One field, no confirmation.

import { useState } from 'react'
import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react'
import { PrimaryButton } from './PrimaryButton'

type Mode = 'setup' | 'unlock'

type Props = {
  mode: Mode
  onSubmit: (passphrase: string) => Promise<void> | void
  onBack?: () => void
  busy?: boolean
}

const MIN_LEN = 8

export function PassphraseEntry({ mode, onSubmit, onBack, busy }: Props) {
  const [value, setValue] = useState('')
  const [confirmValue, setConfirmValue] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSetup = mode === 'setup'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (value.length < MIN_LEN) {
      setError(`Passphrase must be at least ${MIN_LEN} characters.`)
      return
    }
    if (isSetup && value !== confirmValue) {
      setError('Passphrases don’t match.')
      return
    }
    try {
      await onSubmit(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
        {isSetup ? 'Set a passphrase' : 'Enter your passphrase'}
      </h2>
      <p className="text-[14px] leading-relaxed text-ink-soft">
        {isSetup ? (
          <>
            Your passkey provider doesn’t support the encryption extension
            Pampalo prefers, so we’ll encrypt your wallet with a passphrase
            instead. Pick something memorable — there’s no way to recover it.
          </>
        ) : (
          <>
            This wallet is protected by a passphrase. Enter it to unlock.
          </>
        )}
      </p>

      {isSetup && (
        <div className="rounded-2xl bg-paper-lo border border-line px-3.5 py-3 text-[13px] leading-relaxed text-ink-soft">
          <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
            Tip
          </p>
          <p>
            You’re probably using 1Password — save this as a website login so
            you can autofill it next time with Face ID.
          </p>
          <p className="mt-1.5">
            Pampalo will never store this passphrase on any backend server,
            encrypted or otherwise.
          </p>
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
          Passphrase
        </span>
        <div className="flex items-center gap-2 rounded-2xl bg-paper-lo border border-line px-3 py-2.5 focus-within:ring-3 focus-within:ring-ink/15">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 bg-transparent text-[14px] font-medium text-ink placeholder:text-ink-mute focus:outline-none"
            placeholder="At least 8 characters"
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="text-ink-mute hover:text-ink"
            aria-label={show ? 'Hide passphrase' : 'Show passphrase'}
            tabIndex={-1}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </label>

      {isSetup && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
            Confirm passphrase
          </span>
          <div className="flex items-center gap-2 rounded-2xl bg-paper-lo border border-line px-3 py-2.5 focus-within:ring-3 focus-within:ring-ink/15">
            <input
              type={show ? 'text' : 'password'}
              value={confirmValue}
              onChange={(e) => setConfirmValue(e.target.value)}
              autoComplete="new-password"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent text-[14px] font-medium text-ink placeholder:text-ink-mute focus:outline-none"
              placeholder="Type it again"
              disabled={busy}
            />
          </div>
        </label>
      )}

      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}

      <PrimaryButton type="submit" disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="size-[18px] animate-spin" />
            {isSetup ? 'Encrypting…' : 'Unlocking…'}
          </>
        ) : isSetup ? (
          'Encrypt wallet'
        ) : (
          'Unlock'
        )}
      </PrimaryButton>

      {onBack && (
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="self-center inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-mute underline underline-offset-2 hover:text-ink-soft disabled:opacity-50"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </button>
      )}
    </form>
  )
}

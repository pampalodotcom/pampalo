// AUTH.md §10. Modal flow:
//
//   1. Blurred panel + "Tap to reveal."
//   2. Reveal → show all 12 words, with Copy + Download. Copy / Download /
//      "I've saved it" are gated by a 10s read-timer that starts on reveal
//      so the user is forced to actually look at the words.
//   3. "I’ve saved it" → confirmation step asks user to type words at 3
//      random positions. Three correct entries advances.
//
// On confirmation:
//   - 60s timer overwrites clipboard if Copy was used.
//   - Mnemonic is overwritten in memory and dropped.
//
// TODO(1password-mnemonic-save): When the user is on a non-PRF passkey
// provider (1Password, Bitwarden, older Windows Hello, …) we should
// surface a hint to save the mnemonic as a Secure Note in that same
// manager — they already trust it, and it gives them Face/Touch ID
// backed retrieval without us inventing anything. Longer-term, look
// into whether 1Password exposes any kind of API/extension hook for
// programmatic Secure Note creation so we can offer one-tap save.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Eye, EyeOff, Copy as CopyIcon, Check } from 'lucide-react'
import { toast } from 'sonner'
import { PrimaryButton } from './PrimaryButton'
import { cn } from '@/lib/utils'

type Props = {
  mnemonic: string
  address: string
  // 'setup' is the post-registration flow: reveal → confirm (typed-word check)
  // → call onConfirmed. 'export' is the on-demand reveal from the account
  // page: reveal → "Done" → call onConfirmed (caller clears the mnemonic).
  // In export mode there's no confirm step and no skip link.
  mode?: 'setup' | 'export'
  onConfirmed: () => void
  onSkip?: () => void
}

const READ_TIMER_MS = 10_000

export function MnemonicReveal({
  mnemonic,
  address,
  mode = 'setup',
  onConfirmed,
  onSkip,
}: Props) {
  const [stage, setStage] = useState<'reveal' | 'confirm'>('reveal')
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  // Set to a wall-clock timestamp the first time the user reveals. The
  // 10s read-window runs from that point even if they later toggle hide.
  const [revealStartAt, setRevealStartAt] = useState<number | null>(null)
  const [readProgress, setReadProgress] = useState(0)
  const canProceed = readProgress >= 1
  const words = useMemo(() => mnemonic.split(/\s+/).filter(Boolean), [mnemonic])
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  useEffect(() => {
    return () => {
      if (clipboardClearTimerRef.current)
        clearTimeout(clipboardClearTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (revealStartAt === null) return
    let raf = 0
    const tick = () => {
      const elapsed = Date.now() - revealStartAt
      const p = Math.min(1, elapsed / READ_TIMER_MS)
      setReadProgress(p)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [revealStartAt])

  function reveal() {
    setRevealed(true)
    if (revealStartAt === null) setRevealStartAt(Date.now())
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(mnemonic)
      setCopied(true)
      toast('Recovery phrase copied', { duration: 2000 })
      if (clipboardClearTimerRef.current)
        clearTimeout(clipboardClearTimerRef.current)
      clipboardClearTimerRef.current = setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {
          /* some browsers refuse async clipboard writes */
        })
        setCopied(false)
      }, 60_000)
    } catch {
      toast.error('Couldn’t copy — write it down instead.')
    }
  }

  function onDownload() {
    const first6 = address.slice(2, 8)
    const blob = new Blob(
      [`# Recovery phrase for 0x${first6}…\n${mnemonic}\n`],
      { type: 'text/plain' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `wallet-recovery-${first6}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (stage === 'reveal') {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
          {mode === 'export' ? 'Your account secret' : 'Your recovery phrase'}
        </h2>
        <p className="text-[14px] leading-relaxed text-ink-soft">
          {mode === 'export'
            ? 'Anyone with these 12 words can take your wallet. Only display them somewhere private, and never share them.'
            : 'Write these 12 words down somewhere private. They’re the only way to recover your wallet if you lose access to your passkey.'}
        </p>

        <div className="relative">
          <div
            className={cn(
              'grid grid-cols-3 gap-2 rounded-2xl bg-paper-lo border border-line p-3',
              !revealed && 'blur-sm select-none',
            )}
          >
            {words.map((w, i) => (
              <div
                key={i}
                className="rounded-xl bg-card px-2.5 py-2 text-[13px] font-medium text-ink"
              >
                <span className="text-ink-mute mr-1.5 font-mono text-[11px]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {w}
              </div>
            ))}
          </div>
          {!revealed && (
            <button
              type="button"
              className="absolute inset-0 flex items-center justify-center rounded-2xl"
              onClick={reveal}
            >
              <span className="rounded-full bg-card/95 border border-line px-3.5 py-1.5 text-[12.5px] font-semibold text-ink shadow">
                Tap to reveal
              </span>
            </button>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => (revealed ? setRevealed(false) : reveal())}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink"
          >
            {revealed ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
            {revealed ? 'Hide' : 'Reveal'}
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={!revealed || !canProceed}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-50"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={!revealed || !canProceed}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-50"
          >
            <Download className="size-4" /> Download
          </button>
        </div>

        {revealed && !canProceed && (
          <div aria-live="polite">
            <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-ink-mute">
              <span>Take a moment — write these down somewhere safe.</span>
              <span className="font-mono tabular-nums">
                {Math.ceil((1 - readProgress) * (READ_TIMER_MS / 1000))}s
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-paper-lo">
              <div
                className="h-full rounded-full bg-accent"
                style={{
                  width: `${readProgress * 100}%`,
                  willChange: 'width',
                }}
              />
            </div>
          </div>
        )}

        <PrimaryButton
          disabled={!canProceed}
          onClick={() =>
            mode === 'export' ? onConfirmed() : setStage('confirm')
          }
        >
          {mode === 'export' ? 'Done' : 'I’ve saved it'}
        </PrimaryButton>

        {mode === 'setup' && onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="self-center text-[13px] font-medium text-ink-mute underline underline-offset-2 hover:text-ink-soft"
          >
            I&apos;ll do this later
          </button>
        )}
      </div>
    )
  }

  // Confirm stage is only reachable in 'setup' mode (the reveal-stage button
  // calls onConfirmed directly in 'export' mode), so onSkip is always
  // defined here. Fall back to a no-op for the type system.
  return (
    <ConfirmStep
      words={words}
      onConfirmed={onConfirmed}
      onSkip={onSkip ?? (() => {})}
    />
  )
}

function ConfirmStep({
  words,
  onConfirmed,
  onSkip,
}: {
  words: Array<string>
  onConfirmed: () => void
  onSkip: () => void
}) {
  const positions = useMemo(
    () => pickThreeDistinct(words.length),
    [words.length],
  )
  const [values, setValues] = useState<Array<string>>(['', '', ''])
  const [error, setError] = useState<string | null>(null)

  function onSubmit() {
    for (let i = 0; i < 3; i++) {
      if (values[i].trim().toLowerCase() !== words[positions[i] - 1]) {
        setError('That’s not quite right — check the words and try again.')
        return
      }
    }
    setError(null)
    onConfirmed()
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
        Confirm your phrase
      </h2>
      <p className="text-[14px] leading-relaxed text-ink-soft">
        Type the words at these positions to confirm you saved them.
      </p>

      <div className="flex flex-col gap-2.5">
        {positions.map((p, i) => (
          <label
            key={p}
            className="flex items-center gap-3 rounded-2xl bg-paper-lo border border-line px-3 py-2"
          >
            <span className="font-mono text-[12px] text-ink-mute w-7 shrink-0">
              {String(p).padStart(2, '0')}
            </span>
            <input
              type="text"
              value={values[i]}
              onChange={(e) =>
                setValues((v) => {
                  const next = [...v]
                  next[i] = e.target.value
                  return next
                })
              }
              className="flex-1 bg-transparent text-[14px] font-medium text-ink placeholder:text-ink-mute focus:outline-none"
              placeholder={`Word ${p}`}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}

      <PrimaryButton onClick={onSubmit}>Continue</PrimaryButton>

      <button
        type="button"
        onClick={onSkip}
        className="self-center text-[13px] font-medium text-ink-mute underline underline-offset-2 hover:text-ink-soft"
      >
        I&apos;ll do this later
      </button>
    </div>
  )
}

function pickThreeDistinct(n: number): Array<number> {
  const set = new Set<number>()
  while (set.size < 3) {
    set.add(1 + Math.floor(Math.random() * n))
  }
  return Array.from(set).sort((a, b) => a - b)
}

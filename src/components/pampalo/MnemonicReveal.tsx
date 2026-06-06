// AUTH.md §10 / ADR 0013. Export-only reveal — the single surface in the
// app that ever displays the recovery phrase. Reached via the Account
// page's "Export recovery phrase" button or the PageLayout backup banner,
// always behind a fresh passkey ceremony.
//
//   1. Blurred panel + "Tap to reveal."
//   2. Reveal → show all 12 words, with Copy + Download. Copy / Download /
//      "Done" are gated by a 10s read-timer that starts on reveal so the
//      user is forced to actually look at the words.
//   3. Copy or Download marks the wallet backed up (`mnemonicBackedUpAt`
//      in the encrypted prefs blob) — that's what clears the backup
//      banner. Merely revealing does not count.
//
// On Copy: 60s timer overwrites the clipboard. On "Done": the caller
// drops the plaintext reference.
//
// TODO(1password-mnemonic-save): When the user is on a non-PRF passkey
// provider (1Password, Bitwarden, older Windows Hello, …) we should
// surface a hint to save the mnemonic as a Secure Note in that same
// manager — they already trust it, and it gives them Face/Touch ID
// backed retrieval without us inventing anything. Longer-term, look
// into whether 1Password exposes any kind of API/extension hook for
// programmatic Secure Note creation so we can offer one-tap save.

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, EyeOff, Copy as CopyIcon, Check } from "lucide-react";
import { toast } from "sonner";
import { PrimaryButton } from "./PrimaryButton";
import { setPref } from "@/lib/preferences";
import { cn } from "@/lib/utils";

type Props = {
  mnemonic: string;
  address: string;
  // "Done" tapped — caller clears the plaintext mnemonic from state.
  onDone: () => void;
};

const READ_TIMER_MS = 10_000;

// The user has the phrase off-device — record it in the encrypted prefs
// blob. Monotonic (max-merged on sync, see preferences.ts) so a stale
// device can never un-back-up the wallet. ADR 0013.
function markBackedUp() {
  setPref("mnemonicBackedUpAt", Date.now());
}

export function MnemonicReveal({ mnemonic, address, onDone }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  // Set to a wall-clock timestamp the first time the user reveals. The
  // 10s read-window runs from that point even if they later toggle hide.
  const [revealStartAt, setRevealStartAt] = useState<number | null>(null);
  const [readProgress, setReadProgress] = useState(0);
  // `hasSaved` flips true when the user successfully copies or downloads.
  // It's treated as proof they have the phrase off-device, so the "Done"
  // gate doesn't require also reading on-screen for the full 10s window.
  const [hasSaved, setHasSaved] = useState(false);
  const canProceed = readProgress >= 1 || hasSaved;
  const words = useMemo(
    () => mnemonic.split(/\s+/).filter(Boolean),
    [mnemonic],
  );
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    return () => {
      if (clipboardClearTimerRef.current)
        clearTimeout(clipboardClearTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (revealStartAt === null) return;
    let raf = 0;
    const tick = () => {
      const elapsed = Date.now() - revealStartAt;
      const p = Math.min(1, elapsed / READ_TIMER_MS);
      setReadProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [revealStartAt]);

  function reveal() {
    setRevealed(true);
    if (revealStartAt === null) setRevealStartAt(Date.now());
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setHasSaved(true);
      markBackedUp();
      toast("Recovery phrase copied", { duration: 2000 });
      if (clipboardClearTimerRef.current)
        clearTimeout(clipboardClearTimerRef.current);
      clipboardClearTimerRef.current = setTimeout(() => {
        navigator.clipboard.writeText("").catch(() => {
          /* some browsers refuse async clipboard writes */
        });
        setCopied(false);
      }, 60_000);
    } catch {
      toast.error("Couldn’t copy — write it down instead.");
    }
  }

  function onDownload() {
    const first6 = address.slice(2, 8);
    // 1..1000 inclusive. Disambiguates repeated downloads for the same
    // wallet so the OS doesn't silently overwrite an earlier file.
    const suffix = 1 + Math.floor(Math.random() * 1000);
    const blob = new Blob(
      [`# Recovery phrase for 0x${first6}…\n${mnemonic}\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wallet-recovery-${first6}-${suffix}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setHasSaved(true);
    markBackedUp();
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
        Your recovery phrase
      </h2>
      <p className="text-[14px] leading-relaxed text-ink-soft">
        Anyone with these 12 words can take your wallet — only display them
        somewhere private, and never share them. They’re the only way to
        recover your wallet if you lose access to your passkey.
      </p>

      <div className="relative">
        <div
          className={cn(
            "grid grid-cols-3 gap-2 rounded-2xl bg-paper-lo border border-line p-3",
            !revealed && "blur-sm select-none",
          )}
        >
          {words.map((w, i) => (
            <div
              key={i}
              className="rounded-xl bg-card px-2.5 py-2 text-[13px] font-medium text-ink"
            >
              <span className="text-ink-mute mr-1.5 font-mono text-[11px]">
                {String(i + 1).padStart(2, "0")}
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
          {revealed ? "Hide" : "Reveal"}
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink"
        >
          {copied ? (
            <Check className="size-4" />
          ) : (
            <CopyIcon className="size-4" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink"
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
                willChange: "width",
              }}
            />
          </div>
        </div>
      )}

      <PrimaryButton disabled={!canProceed} onClick={onDone}>
        Done
      </PrimaryButton>
    </div>
  );
}

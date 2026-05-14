// AUTH.md §10. Modal flow:
//
//   1. Blurred panel + "Tap to reveal."
//   2. Reveal → show all 12 words, with Copy + Download.
//   3. "I’ve saved it" → confirmation step asks user to type words at 3
//      random positions. Three correct entries advances.
//
// On confirmation:
//   - 60s timer overwrites clipboard if Copy was used.
//   - Mnemonic is overwritten in memory and dropped.

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, EyeOff, Copy as CopyIcon, Check } from "lucide-react";
import { toast } from "sonner";
import { PrimaryButton } from "./PrimaryButton";
import { cn } from "@/lib/utils";

type Props = {
  mnemonic: string;
  address: string;
  onConfirmed: () => void;
};

export function MnemonicReveal({ mnemonic, address, onConfirmed }: Props) {
  const [stage, setStage] = useState<"reveal" | "confirm">("reveal");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = useMemo(() => mnemonic.split(/\s+/).filter(Boolean), [mnemonic]);
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current);
    };
  }, []);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      toast("Recovery phrase copied", { duration: 2000 });
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current);
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
    const blob = new Blob(
      [`# Recovery phrase for 0x${first6}…\n${mnemonic}\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wallet-recovery-${first6}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (stage === "reveal") {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
          Your recovery phrase
        </h2>
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Write these 12 words down somewhere private. They’re the only way
          to recover your wallet if you lose access to your passkey.
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
              onClick={() => setRevealed(true)}
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
            onClick={() => setRevealed((v) => !v)}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink"
          >
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            {revealed ? "Hide" : "Reveal"}
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={!revealed}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-50"
          >
            {copied ? <Check className="size-4" /> : <CopyIcon className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={!revealed}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-card px-3 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-50"
          >
            <Download className="size-4" /> Download
          </button>
        </div>

        <PrimaryButton
          disabled={!revealed}
          onClick={() => setStage("confirm")}
        >
          I’ve saved it
        </PrimaryButton>
      </div>
    );
  }

  return <ConfirmStep words={words} onConfirmed={onConfirmed} />;
}

function ConfirmStep({
  words,
  onConfirmed,
}: {
  words: Array<string>;
  onConfirmed: () => void;
}) {
  const positions = useMemo(() => pickThreeDistinct(words.length), [words.length]);
  const [values, setValues] = useState<Array<string>>(["", "", ""]);
  const [error, setError] = useState<string | null>(null);

  function onSubmit() {
    for (let i = 0; i < 3; i++) {
      if (values[i].trim().toLowerCase() !== words[positions[i] - 1]) {
        setError("That’s not quite right — check the words and try again.");
        return;
      }
    }
    setError(null);
    onConfirmed();
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
              {String(p).padStart(2, "0")}
            </span>
            <input
              type="text"
              value={values[i]}
              onChange={(e) =>
                setValues((v) => {
                  const next = [...v];
                  next[i] = e.target.value;
                  return next;
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
    </div>
  );
}

function pickThreeDistinct(n: number): Array<number> {
  const set = new Set<number>();
  while (set.size < 3) {
    set.add(1 + Math.floor(Math.random() * n));
  }
  return Array.from(set).sort((a, b) => a - b);
}

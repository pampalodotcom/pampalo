import { useEffect, useMemo, useRef, useState } from "react";
import { Wallet } from "ethers";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { deriveAddresses, type DerivedAddresses } from "@/lib/derive-addresses";
import { parseRecoveryPhrase, type ParseResult } from "@/lib/recovery-phrase";
import { PrfNotSupportedError, recoverAccount } from "@/lib/auth-flow";
import { setPref } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { PrimaryButton } from "./PrimaryButton";
import { SecondaryButton } from "./SecondaryButton";

// Recover account form — used on the unknown-device shell when the user
// has a recovery phrase but no enrolled passkey here. See ADR 0003 for
// why this creates a fresh server-side wallet row rather than re-using
// the original.

type Props = {
  /** Back arrow target — restores the previous sign-in-choice screen. */
  onBack: () => void;
  /** Success → caller should navigate into the wallet. */
  onRecovered: () => void;
  /** PRF-missing on this device — caller shows the PasskeyHelp screen. */
  onPrfMissing: () => void;
};

export function RecoverAccount({ onBack, onRecovered, onPrfMissing }: Props) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParseResult>({ status: "empty" });
  const [busy, setBusy] = useState(false);
  // Mask by default. Recovery phrase is shoulder-surf bait the moment
  // it lands in the field — toggle is opt-in verification, not the
  // default state. Resets to false on next mount (when the user opens
  // Recover again) because the component unmounts on navigation.
  const [revealed, setRevealed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Debounced parse — 200ms quiet period so users don't get yelled at
  // mid-typing.
  useEffect(() => {
    const handle = setTimeout(() => setParsed(parseRecoveryPhrase(text)), 200);
    return () => clearTimeout(handle);
  }, [text]);

  function onChooseFile() {
    fileInputRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires again.
    e.target.value = "";
    if (!file) return;
    try {
      const contents = await file.text();
      setText(contents);
    } catch {
      toast.error("Couldn’t read that file.");
    }
  }

  async function onSubmit() {
    if (parsed.status !== "valid" || busy) return;
    setBusy(true);
    try {
      await recoverAccount(parsed.mnemonic);
      // The user just proved possession of the recovery phrase by typing
      // it — the fresh prefs blob (new userId, ADR 0003) shouldn't nag
      // them to back up. ADR 0013.
      setPref("mnemonicBackedUpAt", Date.now());
      // Don't keep the plaintext around once the ceremony succeeded.
      setText("");
      setParsed({ status: "empty" });
      onRecovered();
    } catch (e) {
      if (e instanceof PrfNotSupportedError) {
        onPrfMissing();
        return;
      }
      const msg = e instanceof Error ? e.message : "Recovery failed.";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-serif text-[26px] font-bold leading-tight text-ink">
        Recover account
      </h2>
      <p className="text-[14px] leading-relaxed text-ink-soft">
        Paste your 12-word recovery phrase, or load the{" "}
        <strong>wallet-recovery</strong>.txt file you downloaded.
      </p>

      <div className="relative">
        <textarea
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder="abandon abandon abandon …"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          rows={4}
          // -webkit-text-security renders each character as `disc`
          // without affecting cursor position, selection, or layout —
          // same trick password managers use when they need a
          // multi-line masked field. The placeholder isn't affected.
          // CSSProperties doesn't know about the WebKit prefix, hence
          // the explicit cast.
          style={
            {
              WebkitTextSecurity: revealed ? "none" : "disc",
            } as React.CSSProperties & { WebkitTextSecurity?: string }
          }
          className={cn(
            "w-full resize-none rounded-2xl border border-line bg-paper-lo",
            "px-3.5 py-3 pr-10 text-[14px] leading-relaxed font-mono text-ink",
            "outline-none transition-shadow focus:ring-3 focus:ring-ink/10",
            "placeholder:text-ink-mute",
          )}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          disabled={busy}
          aria-label={
            revealed ? "Hide recovery phrase" : "Show recovery phrase"
          }
          title={revealed ? "Hide" : "Show"}
          className={cn(
            "absolute right-2 top-2 inline-flex size-7 items-center justify-center",
            "rounded-md text-ink-mute hover:bg-paper hover:text-ink-soft",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {revealed ? (
            <EyeOff className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
        </button>
      </div>

      <div className="-mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onChooseFile}
          disabled={busy}
          className="text-[13px] font-medium text-ink-mute underline underline-offset-2 hover:text-ink-soft disabled:opacity-50"
        >
          Choose file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={onFileChosen}
        />
        <ValidationHint result={parsed} />
      </div>

      {parsed.status === "valid" && (
        <AddressPreview mnemonic={parsed.mnemonic} />
      )}

      {/* Preferences-reset warning — the only user-observable
          consequence of the "fresh wallet row per recovery" reality
          (ADR 0003). Kept short on purpose. */}
      <p className="rounded-xl bg-paper-lo border border-line px-3 py-2 text-[12.5px] text-ink-soft">
        Heads up: this enrols a new passkey on this device. Your saved app
        preferences (currency, default chain) won’t carry over from your other
        device.
      </p>

      <div className="flex flex-col gap-2.5">
        <PrimaryButton
          onClick={onSubmit}
          disabled={parsed.status !== "valid" || busy}
        >
          {busy ? (
            <>
              <Loader2 className="size-[18px] animate-spin" />
              Recovering…
            </>
          ) : (
            "Recover account"
          )}
        </PrimaryButton>
        <SecondaryButton onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" />
          Back
        </SecondaryButton>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────

function ValidationHint({ result }: { result: ParseResult }) {
  // Suppress feedback until the user has at least 12 tokens — anything
  // shorter is "still typing." `wrong-count` only fires for OVER 12.
  if (result.status === "empty" || result.status === "partial") return null;

  if (result.status === "valid") {
    return (
      <span className="text-[12px] font-medium text-[var(--pub)]">
        ✓ Valid recovery phrase
      </span>
    );
  }

  const message =
    result.status === "wrong-count"
      ? `Should be 12 words; got ${result.count}.`
      : result.status === "invalid-word"
        ? `“${result.badWord}” isn’t in the BIP-39 word list. Check for typos.`
        : "These words don’t form a valid phrase. Double-check spelling and word order.";

  return <span className="text-[12px] text-warn-fg">{message}</span>;
}

function AddressPreview({ mnemonic }: { mnemonic: string }) {
  const [showMore, setShowMore] = useState(false);

  // Derive once per mnemonic. The derivation runs the same code path
  // as registration / re-auth, so its cost is well-understood.
  const addresses: DerivedAddresses | null = useMemo(() => {
    try {
      const wallet = Wallet.fromPhrase(mnemonic);
      return deriveAddresses(wallet);
    } catch {
      return null;
    }
  }, [mnemonic]);

  if (!addresses) return null;
  return (
    <div className="rounded-2xl bg-paper-lo border border-line px-3.5 py-3 flex flex-col gap-2.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-mute">
        This will recover:
      </p>

      <AddressField label="EVM address" value={addresses.evm} mono />

      <button
        type="button"
        onClick={() => setShowMore((s) => !s)}
        className="inline-flex items-center gap-1 self-start text-[12px] font-medium text-ink-mute hover:text-ink-soft"
      >
        {showMore ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        Show envelope key and Poseidon identifier
      </button>

      {showMore && (
        <>
          <AddressField label="Envelope key" value={addresses.envelope} mono />
          <AddressField
            label="Poseidon identifier"
            value={addresses.poseidon}
            mono
          />
        </>
      )}
    </div>
  );
}

function AddressField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink-mute">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 break-all text-[12.5px] text-ink",
          mono && "font-mono",
        )}
      >
        {value}
      </p>
    </div>
  );
}

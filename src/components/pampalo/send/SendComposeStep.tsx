import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import { formatEther } from "ethers";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { usePublicBalance } from "@/lib/balances";
import { ETH_SENTINEL } from "@/lib/eth";
import {
  getNotesSnapshot,
  isNotesHydrated,
  subscribeNotes,
} from "@/lib/idb-notes";
import { AssetMark } from "@/components/pampalo/AssetMark";
import { NetworkLogo } from "@/components/pampalo/deposit/NetworkLogo";
import { SunIcon, MoonIcon } from "@/components/pampalo/SunMoonIcons";
import type { SendInputUnit, SendMode, SendRecipient } from "./SendSheet";

// Step 2 — amount + recipient.
//
// Demo cuts:
//   - ETH only (no token picker yet). The asset row is shown as a
//     read-only ETH pill so the structure matches the design spec
//     and is easy to expand.
//   - Manual recipient inputs only. Contacts + payment-code parser
//     stay deferred (per the spec triage in conversation).
//   - No Max button yet; the user types the amount. Max needs the
//     mode-aware balance hook to land — small follow-up.

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32BYTE = /^0x[0-9a-fA-F]{64}$/;
const HEX_UNCOMPRESSED_PUBKEY = /^0x04[0-9a-fA-F]{128}$/;

export function SendComposeStep({
  mode,
  chainId,
  evmAddress,
  amount,
  onAmountChange,
  inputUnit,
  onInputUnitChange,
  recipient,
  onRecipientChange,
  onBack,
  onContinue,
}: {
  mode: SendMode;
  chainId: number | null;
  evmAddress: string;
  amount: string;
  onAmountChange: (next: string) => void;
  inputUnit: SendInputUnit;
  onInputUnitChange: (next: SendInputUnit) => void;
  recipient: SendRecipient | null;
  onRecipientChange: (next: SendRecipient | null) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const accent = mode === "private" ? "priv" : "pub";

  // ETH/USD spot — powers the inputUnit toggle. Same shape the Swap
  // modal uses ("eth/usd" shortId in the chainlink feeds).
  const prices = useQuery(api.prices.feeds.listLatest, {});
  const ethUsdPrice = useMemo<number | null>(() => {
    if (!prices) return null;
    const feed = prices.find((p) => p.shortId === "eth/usd");
    if (!feed) return null;
    return Number(feed.answer) / 10 ** feed.feedDecimals;
  }, [prices]);

  const toggleInputUnit = () => {
    if (!ethUsdPrice || ethUsdPrice <= 0) return;
    const next: SendInputUnit = inputUnit === "token" ? "usd" : "token";
    const n = Number(amount);
    if (amount && Number.isFinite(n) && n > 0) {
      onAmountChange(
        next === "usd"
          ? (n * ethUsdPrice).toFixed(2)
          : (n / ethUsdPrice).toFixed(6),
      );
    }
    onInputUnitChange(next);
  };

  const secondaryLine = useMemo(() => {
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n <= 0) return "";
    if (!ethUsdPrice || ethUsdPrice <= 0) return "";
    if (inputUnit === "token") return `≈ $${(n * ethUsdPrice).toFixed(2)}`;
    return `≈ ${(n / ethUsdPrice).toFixed(6)} ETH`;
  }, [amount, inputUnit, ethUsdPrice]);

  // Mode-aware balance display.
  // Public: live `usePublicBalance` against the chain's native asset.
  // Private: sum of `state==="spendable"` ETH notes on this chain.
  const pubBalance = usePublicBalance(
    chainId !== null
      ? {
          chainId,
          address: ETH_SENTINEL,
          symbol: "ETH",
          decimals: 18,
        }
      : {
          chainId: 1,
          address: "0x0000000000000000000000000000000000000000",
          symbol: "",
          decimals: 18,
        },
    chainId !== null && mode === "public" ? evmAddress : null,
  );
  const notes = useSyncExternalStore(
    subscribeNotes,
    getNotesSnapshot,
    () => getNotesSnapshot(),
  );
  const privSpendableWei = useMemo<bigint>(() => {
    if (mode !== "private" || chainId === null) return 0n;
    if (!isNotesHydrated()) return 0n;
    let sum = 0n;
    for (const n of notes) {
      if (
        n.state === "spendable" &&
        n.networkChainId === chainId &&
        n.asset === ETH_SENTINEL
      ) {
        sum += BigInt(n.amount);
      }
    }
    return sum;
  }, [mode, chainId, notes]);

  const balanceWei =
    mode === "private"
      ? privSpendableWei
      : pubBalance.data?.balanceWei ?? null;
  const balanceLabel =
    balanceWei !== null
      ? formatEther(balanceWei)
      : null;
  // For private send the max-spendable per-tx is the largest single
  // note (we don't multi-input join yet). For public, it's the wallet
  // balance minus a small ETH gas buffer.
  const maxSpendable = useMemo<bigint>(() => {
    if (mode === "private") {
      // Single-input demo path: per-tx cap = largest spendable note.
      let largest = 0n;
      for (const n of notes) {
        if (
          n.state === "spendable" &&
          n.networkChainId === chainId &&
          n.asset === ETH_SENTINEL
        ) {
          const w = BigInt(n.amount);
          if (w > largest) largest = w;
        }
      }
      return largest;
    }
    if (balanceWei === null) return 0n;
    const reserve = 5_000_000_000_000_000n; // 0.005 ETH gas buffer
    return balanceWei > reserve ? balanceWei - reserve : 0n;
  }, [mode, chainId, notes, balanceWei]);

  const onMax = () => {
    if (maxSpendable === 0n) return;
    onAmountChange(formatEther(maxSpendable));
  };

  const amountValid = (() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return false;
    if (inputUnit === "usd") {
      // Need a working ETH/USD feed to convert downstream.
      return ethUsdPrice !== null && ethUsdPrice > 0;
    }
    return true;
  })();
  const recipientValid =
    recipient !== null &&
    (recipient.kind === "public"
      ? HEX_ADDR.test(recipient.address)
      : HEX_32BYTE.test(recipient.poseidon) &&
        HEX_UNCOMPRESSED_PUBKEY.test(recipient.envelope));

  const reviewDisabled = !amountValid || !recipientValid || chainId === null;

  return (
    <div className="flex flex-col gap-5 px-5 pt-2 pb-5 sm:px-6 sm:pt-3 sm:pb-6">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-mute hover:text-ink"
        >
          <ChevronLeft className="size-4" /> Back
        </button>
        <ModeChip mode={mode} chainId={chainId} />
      </div>

      {/* YOU SEND — amount + token pill + balance + max */}
      <div className="rounded-2xl border border-line bg-paper-lo px-4 pt-3 pb-4 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-mute">
            You send
          </p>
          {balanceLabel !== null && (
            <button
              type="button"
              onClick={onMax}
              disabled={maxSpendable === 0n}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 h-6",
                "text-[11px] font-semibold transition-colors",
                accent === "priv"
                  ? "text-[var(--priv)] hover:bg-[var(--priv-soft)]"
                  : "text-[var(--pub)] hover:bg-[var(--pub-soft)]",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {accent === "priv" ? (
                <MoonIcon className="size-3" />
              ) : (
                <SunIcon className="size-3" />
              )}
              <span className="font-mono">{trimEth(balanceLabel)} Max</span>
            </button>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder="0"
            className={cn(
              "min-w-0 flex-1 bg-transparent font-serif text-[34px] font-bold outline-none",
              "tracking-[-0.02em] text-ink placeholder:text-ink-mute/50",
            )}
          />
          <span className="shrink-0 text-[16px] font-medium text-ink-mute/70">
            {inputUnit === "usd" ? "USD" : "ETH"}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 shrink-0 rounded-full",
              "bg-card border border-line h-9 px-2.5",
              "text-[13px] font-semibold text-ink",
            )}
          >
            <AssetMark symbol="ETH" size={22} />
            ETH
          </span>
        </div>
        {/* Secondary equivalent + View-in toggle, matching the
            SwapModal pattern (and SendModal's older one). Hidden
            until both the user has typed something and we have a
            usable ETH/USD price. */}
        {(secondaryLine || ethUsdPrice !== null) && (
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-ink-mute">
            <span className="min-w-0 truncate font-mono">{secondaryLine}</span>
            {ethUsdPrice !== null && (
              <button
                type="button"
                onClick={toggleInputUnit}
                className="shrink-0 text-[10.5px] font-medium text-ink-mute underline-offset-2 hover:text-ink hover:underline"
              >
                View in {inputUnit === "token" ? "USD" : "ETH"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* RECIPIENT */}
      <div className="rounded-2xl border border-line bg-paper-lo px-4 py-3.5 min-w-0">
        <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-mute">
          Recipient
        </p>
        {mode === "public" ? (
          <PublicRecipient
            value={recipient?.kind === "public" ? recipient.address : ""}
            onChange={(v) => onRecipientChange({ kind: "public", address: v })}
          />
        ) : (
          <PrivateRecipient
            poseidon={
              recipient?.kind === "private" ? recipient.poseidon : ""
            }
            envelope={
              recipient?.kind === "private" ? recipient.envelope : ""
            }
            onChange={(p, e) =>
              onRecipientChange({ kind: "private", poseidon: p, envelope: e })
            }
          />
        )}
      </div>

      <button
        type="button"
        onClick={onContinue}
        disabled={reviewDisabled}
        className={cn(
          "inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-full",
          "text-[14px] font-bold text-white shadow-sm",
          accent === "priv"
            ? "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]"
            : "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
          "disabled:cursor-not-allowed disabled:opacity-55",
        )}
      >
        Review transaction
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

// Compact ETH balance — trim trailing zeros and clip to ~5 dp.
function trimEth(raw: string): string {
  if (!raw.includes(".")) return raw;
  let s = raw.replace(/0+$/, "").replace(/\.$/, "");
  const dot = s.indexOf(".");
  if (dot >= 0 && s.length - dot - 1 > 5) {
    s = s.slice(0, dot + 6);
  }
  return s;
}

function ModeChip({
  mode,
  chainId,
}: {
  mode: SendMode;
  chainId: number | null;
}) {
  const accent = mode === "private" ? "priv" : "pub";
  const Icon = mode === "private" ? MoonIcon : SunIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px] font-semibold",
        accent === "priv" ? "text-[var(--priv)]" : "text-[var(--pub)]",
      )}
    >
      <Icon className="size-3" />
      {mode === "private" ? "Private" : "Public"}
      {chainId !== null && (
        <>
          <span className="text-ink-mute mx-0.5">·</span>
          <NetworkLogo chainId={chainId} size={14} />
        </>
      )}
    </span>
  );
}

function PublicRecipient({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const valid = HEX_ADDR.test(value);
  return (
    <div>
      <input
        inputMode="text"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="0x…"
        className={cn(
          "w-full bg-card border rounded-xl px-3 py-2.5",
          "font-mono text-[13px] text-ink outline-none",
          valid
            ? "border-[var(--pub)]"
            : "border-line focus:border-ink-mute",
        )}
      />
      <p className="mt-2 text-[11.5px] text-ink-mute">
        Double-check the address — sends can&apos;t be reversed.
      </p>
    </div>
  );
}

function PrivateRecipient({
  poseidon,
  envelope,
  onChange,
}: {
  poseidon: string;
  envelope: string;
  onChange: (poseidon: string, envelope: string) => void;
}) {
  const poseidonValid = HEX_32BYTE.test(poseidon);
  const envelopeValid = HEX_UNCOMPRESSED_PUBKEY.test(envelope);
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Poseidon address"
        hint="Spend / stealth address (0x + 64 hex)"
        value={poseidon}
        onChange={(v) => onChange(v.trim(), envelope)}
        valid={poseidonValid}
        placeholder="0x…"
      />
      <Field
        label="Envelope key"
        hint="Note encryption key (0x04 + 128 hex, uncompressed secp)"
        value={envelope}
        onChange={(v) => onChange(poseidon, v.trim())}
        valid={envelopeValid}
        placeholder="0x04…"
      />
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  valid,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  valid: boolean;
  placeholder: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-[11.5px] font-bold uppercase tracking-[0.1em] text-ink">
          {label}
        </p>
        <p className="text-[10.5px] text-ink-mute">{hint}</p>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full bg-card border rounded-xl px-3 py-2.5",
          "font-mono text-[12.5px] text-ink outline-none",
          "break-all",
          value && valid
            ? "border-[var(--priv)]"
            : "border-line focus:border-ink-mute",
        )}
      />
    </div>
  );
}

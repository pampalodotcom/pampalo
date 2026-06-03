import { useEffect, useState } from "react";

// Display-currency preference + ETH-balance conversion math. The
// preference is public (not user-secret) so it lives in localStorage
// unencrypted, per the project's "encrypt user secrets only" rule.

export type DisplayCurrency = "USD" | "AUD" | "CAD" | "GBP";

export const DISPLAY_CURRENCIES: ReadonlyArray<DisplayCurrency> = [
  "USD",
  "AUD",
  "CAD",
  "GBP",
];

const STORAGE_KEY = "pampalo:displayCurrency";
const DEFAULT: DisplayCurrency = "USD";

function readPref(): DisplayCurrency {
  if (typeof window === "undefined") return DEFAULT;
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "USD" || v === "AUD" || v === "CAD" || v === "GBP") return v;
  return DEFAULT;
}

export function useDisplayCurrency(): [
  DisplayCurrency,
  (c: DisplayCurrency) => void,
] {
  const [ccy, setCcy] = useState<DisplayCurrency>(DEFAULT);
  useEffect(() => {
    setCcy(readPref());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setCcy(readPref());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const update = (next: DisplayCurrency) => {
    setCcy(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private-mode / quota — ignore */
    }
  };
  return [ccy, update];
}

// ─── Price math ──────────────────────────────────────────────────────────
// Inputs come from `api.prices.feeds.listLatest` — raw int answers + feedDecimals.
// All conversions are done as numbers (JS double) because display precision
// at ~$thousands of ETH is well within Float64 safety. Wei → ETH uses
// BigInt division first to keep integer math accurate.

export type PriceRow = {
  shortId: string;
  answer: string; // int as decimal string
  feedDecimals: number;
};

function priceToNumber(row: PriceRow): number {
  // answer is a signed int but Chainlink fiat-pair feeds always return
  // positive values. BigInt -> Number conversion via decimal string keeps
  // precision: divide by 10^decimals using Number arithmetic, fine for
  // human-readable display.
  const raw = Number(row.answer);
  return raw / 10 ** row.feedDecimals;
}

/**
 * Convert a native-token wei balance into the user's display currency.
 *
 * Feed catalog (mainnet, base/quote):
 *   eth/usd  — direct: ETH worth in USD
 *   aud/usd  — invert to get USD/AUD multiplier
 *   cad/usd  — invert to get USD/CAD multiplier
 *   gbp/usd  — invert to get USD/GBP multiplier
 *
 * Returns null if a required feed is missing.
 */
export function convertEthToCurrency(
  weiBalance: bigint,
  ethDecimals: number,
  target: DisplayCurrency,
  prices: ReadonlyArray<PriceRow>,
): number | null {
  const byId = new Map(prices.map((p) => [p.shortId, p]));
  const ethUsdRow = byId.get("eth/usd");
  if (!ethUsdRow) return null;
  const ethUsd = priceToNumber(ethUsdRow);

  // Convert wei -> ETH-as-Number with enough precision for display. Split
  // into integer and fractional parts so we don't lose precision on big
  // balances.
  const divisor = 10n ** BigInt(ethDecimals);
  const whole = Number(weiBalance / divisor);
  const frac = Number(weiBalance % divisor) / Number(divisor);
  const ethAmount = whole + frac;
  const usdAmount = ethAmount * ethUsd;

  if (target === "USD") return usdAmount;

  const xyzUsdRow = byId.get(`${target.toLowerCase()}/usd`);
  if (!xyzUsdRow) return null;
  const xyzUsd = priceToNumber(xyzUsdRow);
  if (xyzUsd === 0) return null;
  return usdAmount / xyzUsd;
}

const FORMATTERS: Record<DisplayCurrency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  AUD: new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }),
  CAD: new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }),
  GBP: new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }),
};

export function formatCurrency(amount: number, ccy: DisplayCurrency): string {
  return FORMATTERS[ccy].format(amount);
}

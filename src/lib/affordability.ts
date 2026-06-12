import { weiToNumber } from "./balances";

// Pre-broadcast affordability check (CONTEXT.md "Affordability preflight").
// A self-broadcast costs the user `value + gasLimit × maxFeePerGas` in
// native ETH — the exact up-front reservation the node enforces, since
// Pampalo uses fixed per-flow gasLimit constants (no eth_estimateGas, per
// ADR 0004). This is therefore an exact check, not an estimate: if it says
// "short", the broadcast WOULD revert with "insufficient funds".
//
// Relayed transfer/unshield do NOT call this — the relayer pays gas, so the
// user needs zero native ETH. Callers gate on the self-broadcast path.

export type Affordability =
  | { ok: true }
  // Not enough native ETH for value + gas.
  | { ok: false; reason: "native"; neededWei: bigint; haveWei: bigint; symbol: string }
  // Not enough of the ERC-20 being moved (public ERC-20 send).
  | {
      ok: false;
      reason: "token";
      neededWei: bigint;
      haveWei: bigint;
      symbol: string;
      decimals: number;
    };

export function checkAffordability(opts: {
  /** Live native-ETH balance for the chain. */
  nativeBalanceWei: bigint;
  nativeSymbol?: string;
  /** Native value the tx sends (the shield/send amount for ETH; 0 for
   *  ERC-20 transfers and note-only flows). */
  valueWei: bigint;
  /** Total gas units across every tx in the flow (e.g. approve + shield). */
  gasLimit: bigint;
  /** maxFeePerGas the signing path will use (= cached gasPriceWei). */
  gasPriceWei: bigint;
  /** ERC-20 leg, when the flow moves a token out of the user's balance. */
  token?: {
    balanceWei: bigint;
    neededWei: bigint;
    symbol: string;
    decimals: number;
  };
}): Affordability {
  const nativeNeeded = opts.valueWei + opts.gasLimit * opts.gasPriceWei;
  if (opts.nativeBalanceWei < nativeNeeded) {
    return {
      ok: false,
      reason: "native",
      neededWei: nativeNeeded,
      haveWei: opts.nativeBalanceWei,
      symbol: opts.nativeSymbol ?? "ETH",
    };
  }
  if (opts.token && opts.token.balanceWei < opts.token.neededWei) {
    return {
      ok: false,
      reason: "token",
      neededWei: opts.token.neededWei,
      haveWei: opts.token.balanceWei,
      symbol: opts.token.symbol,
      decimals: opts.token.decimals,
    };
  }
  return { ok: true };
}

// Round the "need" figure UP at `dp` so we never quote a value the user
// could top up to and still fall short by dust.
function ceilFmt(wei: bigint, decimals: number, dp: number): string {
  const n = weiToNumber(wei, decimals);
  const f = 10 ** dp;
  const up = Math.ceil(n * f) / f;
  return up.toLocaleString("en-US", { maximumFractionDigits: dp });
}

function floorFmt(wei: bigint, decimals: number, dp: number): string {
  const n = weiToNumber(wei, decimals);
  const f = 10 ** dp;
  const down = Math.floor(n * f) / f;
  return down.toLocaleString("en-US", { maximumFractionDigits: dp });
}

/** Human "need ≈X, have Y" copy for a failed check. */
export function affordabilityMessage(
  a: Extract<Affordability, { ok: false }>,
): string {
  if (a.reason === "native") {
    const need = ceilFmt(a.neededWei, 18, 5);
    const have = floorFmt(a.haveWei, 18, 5);
    return `Not enough ${a.symbol} for gas — need ≈${need} ${a.symbol}, have ${have} ${a.symbol}.`;
  }
  const dp = Math.min(a.decimals, 4);
  const need = ceilFmt(a.neededWei, a.decimals, dp);
  const have = floorFmt(a.haveWei, a.decimals, dp);
  return `Not enough ${a.symbol} — need ${need} ${a.symbol}, have ${have} ${a.symbol}.`;
}

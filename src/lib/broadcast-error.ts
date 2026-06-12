// Broadcast-time error normaliser — the backstop behind the affordability
// preflight (CONTEXT.md "Affordability preflight"). A preflight can't catch
// a 30s-stale balance or a gas spike between check and broadcast, so when a
// raw RPC/Convex error surfaces we map known strings to friendly copy and
// keep the raw text behind a details toggle (useful on testnet).

export type NormalizedError = { friendly: string; raw: string };

export function normalizeBroadcastError(err: unknown): NormalizedError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();

  let friendly: string;
  if (m.includes("insufficient funds")) {
    friendly =
      "Not enough ETH to cover this transaction's amount and gas. Top up and try again.";
  } else if (
    m.includes("nonce too low") ||
    m.includes("already known") ||
    m.includes("replacement transaction underpriced")
  ) {
    friendly =
      "This conflicts with a transaction that's still pending. Wait a moment and try again.";
  } else if (
    m.includes("intrinsic gas too low") ||
    m.includes("out of gas") ||
    m.includes("gas required exceeds")
  ) {
    friendly =
      "The transaction couldn't be processed with the current gas settings. Try again.";
  } else if (m.includes("execution reverted") || m.includes("would revert")) {
    friendly = "The transaction would fail on-chain and was not sent.";
  } else {
    friendly = "Couldn't broadcast the transaction.";
  }
  return { friendly, raw };
}

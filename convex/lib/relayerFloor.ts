import type { QueryCtx } from "../_generated/server";

// Per-account relayer funding floor, resolved to wei.
//
// A deployment can express its floor as a fixed USD value
// (`minRelayerBalanceUsdCents`) or a static wei amount
// (`minRelayerBalanceWei`). The USD floor is preferred: it's converted to
// wei at read-time using the live eth/usd price, so "$10 of gas" stays $10
// as ETH moves instead of drifting with the exchange rate. The static wei
// floor is the fallback (testnet, or when no price has been indexed yet).

type Floor = {
  minRelayerBalanceWei?: string;
  minRelayerBalanceUsdCents?: number;
};

/**
 * USD cents → wei at a given eth/usd price.
 *   wei = (cents / 100) dollars × 1e18 wei ÷ (answer / 10^decimals) price
 *       = cents × 10^(decimals + 18) ÷ (answer × 100)
 */
export function usdCentsToWei(
  usdCents: number,
  answer: bigint,
  feedDecimals: number,
): bigint {
  if (answer <= 0n) return 0n;
  return (
    (BigInt(usdCents) * 10n ** (BigInt(feedDecimals) + 18n)) / (answer * 100n)
  );
}

/**
 * Resolve a deployment's funding floor to a wei string. Prefers the USD
 * floor via the live eth/usd `latestPrices` row; falls back to the static
 * wei floor when no USD value is set or no price is available.
 */
export async function resolveMinBalanceWei(
  ctx: QueryCtx,
  dep: Floor,
): Promise<string> {
  if (dep.minRelayerBalanceUsdCents !== undefined) {
    const price = await ctx.db
      .query("latestPrices")
      .withIndex("by_shortId", (q) => q.eq("shortId", "eth/usd"))
      .unique();
    if (price) {
      const wei = usdCentsToWei(
        dep.minRelayerBalanceUsdCents,
        BigInt(price.answer),
        price.feedDecimals,
      );
      if (wei > 0n) return wei.toString();
    }
  }
  return dep.minRelayerBalanceWei ?? "0";
}

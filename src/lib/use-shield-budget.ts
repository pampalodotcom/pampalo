import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";

// Wraps the Convex `shieldQueue.proxy.shieldBudget` action with a tiny
// React-side cache. Fires on mount whenever `enabled`, `chainId`, and
// `user` are stable, and re-fetches on any of those changing. Callers
// pass `enabled: false` to skip the network round-trip entirely (e.g.
// for an asset that isn't shieldable on the active chain).
//
// Returns BigInts (not strings) so caller math doesn't need to remember
// to convert. Returns `null` while loading or on error — callers should
// fall back to an unconstrained slider in that case.

export type ShieldBudget = {
  effectiveCapUsdCents: bigint;
  usdCentsUsedThisMonth: bigint;
  remainingUsdCents: bigint;
};

export function useShieldBudget(
  chainId: number | null,
  user: string | null,
  enabled: boolean,
): ShieldBudget | null {
  const fetcher = useAction(api.shieldQueue.proxy.shieldBudget);
  const [budget, setBudget] = useState<ShieldBudget | null>(null);

  useEffect(() => {
    if (!enabled || chainId === null || !user) {
      setBudget(null);
      return;
    }
    // AbortController for the in-flight fetch. Using `.aborted` instead
    // of a let-rebound flag because ESLint can't model the closure
    // mutation through to the later read.
    const controller = new AbortController();
    void fetcher({ chainId, user })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result === null) return;
        setBudget({
          effectiveCapUsdCents: BigInt(result.effectiveCapUsdCents),
          usdCentsUsedThisMonth: BigInt(result.usdCentsUsedThisMonth),
          remainingUsdCents: BigInt(result.remainingUsdCents),
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setBudget(null);
      });
    return () => {
      controller.abort();
    };
  }, [chainId, user, enabled, fetcher]);

  return budget;
}

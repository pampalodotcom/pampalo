import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";

// Unshield twin of use-shield-budget.ts. Wraps the Convex
// `shieldQueue.proxy.unshieldBudget` action with a tiny React-side cache,
// reading the contract's independent `unshieldUsage` bucket. Same
// contract/leak profile as the shield budget read. Backs the /account
// monthly-cap tracker's "Unshielded this month" bar. Returns BigInts (or
// null while loading / on error).

export type UnshieldBudget = {
  effectiveCapUsdCents: bigint;
  usdCentsUsedThisMonth: bigint;
  remainingUsdCents: bigint;
};

export function useUnshieldBudget(
  chainId: number | null,
  user: string | null,
  enabled: boolean,
): UnshieldBudget | null {
  const fetcher = useAction(api.shieldQueue.proxy.unshieldBudget);
  const [budget, setBudget] = useState<UnshieldBudget | null>(null);

  useEffect(() => {
    if (!enabled || chainId === null || !user) {
      setBudget(null);
      return;
    }
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

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";

// Wraps `shieldQueue.proxy.hasRoles` with a small React-side cache.
// Same shape as `useShieldBudget` — fires on mount when the inputs
// resolve, returns `null` while loading or when the chain has no
// Pampalo deployment, AbortController-cancels on cleanup.
//
// SHIELD_FLOW.md §10.4 calls this option (B) for v1; (C) replaces the
// per-user RPC with an indexed `pampaloRoles` table.

export type DeploymentRoles = {
  vigilantCitizen: boolean;
  boothOperator: boolean;
};

export function useDeploymentRoles(
  chainId: number | null,
  user: string | null,
): DeploymentRoles | null {
  const fetcher = useAction(api.shieldQueue.proxy.hasRoles);
  const [roles, setRoles] = useState<DeploymentRoles | null>(null);

  useEffect(() => {
    if (chainId === null || !user) {
      setRoles(null);
      return;
    }
    const controller = new AbortController();
    void fetcher({ chainId, user })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result === null) {
          // No Pampalo deployment for this chain. Treat as "no roles."
          setRoles({ vigilantCitizen: false, boothOperator: false });
          return;
        }
        setRoles(result);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRoles(null);
      });
    return () => {
      controller.abort();
    };
  }, [chainId, user, fetcher]);

  return roles;
}

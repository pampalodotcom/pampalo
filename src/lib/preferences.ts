import { useEffect, useState } from "react";

// Session-storage backed UI prefs that don't deserve a server round-trip.
// Lives in sessionStorage (not local) so testnets opting in is a per-tab
// affordance — fresh sessions default to mainnet-only, matching the
// principle that testnets are a developer concession, not a feature.

const TESTNETS_KEY = "pampalo:showTestnets";
const TESTNETS_EVENT = "pampalo:testnets-changed";

const TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Sepolia
  421614, // Arbitrum Sepolia
]);

export function isTestnetChainId(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId);
}

function readTestnetsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(TESTNETS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * `[enabled, setEnabled]` — session-scoped. Calling `setEnabled` writes
 * to sessionStorage and broadcasts a same-tab event so other listeners
 * (like the dashboard's filter) update without a manual subscription.
 */
export function useTestnetsEnabled(): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(readTestnetsEnabled());
    const onChange = () => setEnabled(readTestnetsEnabled());
    window.addEventListener(TESTNETS_EVENT, onChange);
    return () => window.removeEventListener(TESTNETS_EVENT, onChange);
  }, []);

  const update = (value: boolean) => {
    setEnabled(value);
    try {
      window.sessionStorage.setItem(TESTNETS_KEY, value ? "1" : "0");
      window.dispatchEvent(new Event(TESTNETS_EVENT));
    } catch {
      /* private mode / quota — keep the in-memory value, drop the write */
    }
  };

  return [enabled, update];
}

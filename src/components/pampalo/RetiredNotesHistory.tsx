import { useMemo, useSyncExternalStore } from "react";
import { formatUnits } from "ethers";
import { History } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ETH_SENTINEL } from "@/lib/eth";
import {
  getNotesSnapshot,
  isNoteRetired,
  subscribeNotes,
} from "@/lib/idb-notes";
import { cn } from "@/lib/utils";

// Read-only history of notes from contracts we've redeployed away from
// (ADR 0018). These notes live in IDB tagged with their OLD deployment
// address, so `isNoteRetired` picks them out once `enabledDeployments`
// loads. They can never be spent (their leaf is in an abandoned tree) —
// this panel only shows "what you held on a previous contract version."
//
// Hidden when there's nothing retired, so the account page stays clean
// for the common (never-redeployed) case.

type AssetTotal = {
  asset: string;
  symbol: string;
  decimals: number;
  amount: bigint;
};

type RetiredGroup = {
  chainId: number;
  deploymentAddress: string;
  networkName: string;
  version: string | null;
  retiredAt: number | null;
  assets: AssetTotal[];
};

function shortContract(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatRetiredDate(ms: number): string {
  // Locale date only — no time-of-day needed for a history label.
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function RetiredNotesHistory() {
  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () =>
    getNotesSnapshot(),
  );
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const archived = useQuery(api.shieldQueue.store.listArchivedDeployments, {});
  const tokens = useQuery(api.catalog.tokens.list, {});

  const groups = useMemo<RetiredGroup[]>(() => {
    // Wait for the enabled set — retirement is underivable without it.
    if (!deployments) return [];

    const networkNameByChain = new Map<number, string>();
    for (const d of deployments) networkNameByChain.set(d.chainId, d.networkName);

    // (chainId:address) → { version, retiredAt } from the marker rows.
    const markerByKey = new Map<
      string,
      { version: string | null; retiredAt: number }
    >();
    for (const a of archived ?? []) {
      markerByKey.set(`${a.chainId}:${a.pampalo.toLowerCase()}`, {
        version: a.version ?? null,
        retiredAt: a.retiredAt,
      });
    }

    const symbolByKey = new Map<string, { symbol: string; decimals: number }>();
    for (const t of tokens ?? []) {
      symbolByKey.set(`${t.chainId}:${t.address.toLowerCase()}`, {
        symbol: t.symbol,
        decimals: t.decimals,
      });
    }

    const byDeployment = new Map<string, RetiredGroup>();
    for (const n of notes) {
      if (!isNoteRetired(n, deployments)) continue;
      // Value-bearing history only: drop already-spent / aborted notes.
      if (
        n.state === "spent" ||
        n.state === "cancelled" ||
        n.state === "contested"
      ) {
        continue;
      }

      const addr = n.deploymentAddress.toLowerCase();
      const key = `${n.networkChainId}:${addr}`;
      let g = byDeployment.get(key);
      if (!g) {
        const marker = markerByKey.get(key);
        g = {
          chainId: n.networkChainId,
          deploymentAddress: addr,
          networkName:
            networkNameByChain.get(n.networkChainId) ??
            `Chain ${n.networkChainId}`,
          version: marker?.version ?? null,
          retiredAt: marker?.retiredAt ?? null,
          assets: [],
        };
        byDeployment.set(key, g);
      }

      const assetLower = n.asset.toLowerCase();
      let at = g.assets.find((a) => a.asset === assetLower);
      if (!at) {
        const sym = symbolByKey.get(`${n.networkChainId}:${assetLower}`);
        at = {
          asset: assetLower,
          symbol:
            assetLower === ETH_SENTINEL ? "ETH" : (sym?.symbol ?? "Token"),
          decimals: sym?.decimals ?? n.assetDecimals,
          amount: 0n,
        };
        g.assets.push(at);
      }
      at.amount += BigInt(n.amount);
    }

    return [...byDeployment.values()].sort(
      (a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0),
    );
  }, [notes, deployments, archived, tokens]);

  if (groups.length === 0) return null;

  return (
    <section className="rise-in rounded-3xl card-cream px-5 py-5">
      <div className="mb-1 flex items-center gap-2">
        <History className="size-4 text-ink-mute" />
        <p className="eyebrow">Previous deployments</p>
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-soft">
        Balances you held on an earlier contract version. These are kept for
        your records and <em>can’t be spent</em> — the contract was redeployed
        and its private notes were retired. Re-shield on the current contract
        to hold funds privately again.
      </p>

      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div
            key={`${g.chainId}:${g.deploymentAddress}`}
            className="rounded-2xl border border-line bg-card px-4 py-3"
          >
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13px] font-semibold text-ink">
                {g.networkName}
              </span>
              {g.version && (
                <span className="rounded-full bg-paper-lo px-2 py-0.5 text-[11px] font-semibold text-ink-mute">
                  v{g.version}
                </span>
              )}
              <span className="text-[12px] text-ink-mute">
                {shortContract(g.deploymentAddress)}
              </span>
              {g.retiredAt !== null && (
                <span className="text-[12px] text-ink-mute">
                  · retired {formatRetiredDate(g.retiredAt)}
                </span>
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {g.assets.map((a) => (
                <li
                  key={a.asset}
                  className={cn(
                    "flex items-center justify-between",
                    "text-[14px] text-ink-soft",
                  )}
                >
                  <span className="font-medium text-ink">{a.symbol}</span>
                  <span className="tabular-nums">
                    {formatUnits(a.amount, a.decimals)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// Re-export the type for any caller that wants to render a subset.
export type { RetiredGroup };

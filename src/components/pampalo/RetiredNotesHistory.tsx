import { useMemo, useState, useSyncExternalStore } from "react";
import { formatUnits } from "ethers";
import { History, Sun } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ETH_SENTINEL } from "@/lib/eth";
import {
  getNotesSnapshot,
  isNoteRetired,
  subscribeNotes,
} from "@/lib/idb-notes";
import { isRetiredDeploymentWithdrawable } from "@/lib/retired-vk";
import type { RetiredNote } from "@/lib/withdraw-retired";
import { cn } from "@/lib/utils";
import {
  RetiredWithdrawSheet,
  type RetiredWithdrawPayload,
} from "./RetiredWithdrawSheet";

// History of notes from contracts we've redeployed away from (ADR 0018).
// These notes live in IDB tagged with their OLD deployment address, so
// `isNoteRetired` picks them out once `enabledDeployments` loads. They can't
// be *spent within* the protocol (their leaf is in an abandoned tree), but —
// for a circuit-compatible redeploy — they can be **withdrawn** to the user's
// public wallet via `unshieldBundled` against the old contract (ADR 0022).
//
// Hidden when there's nothing retired, so the account page stays clean for the
// common (never-redeployed) case.

type AssetTotal = {
  asset: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  notes: RetiredNote[];
};

type RetiredGroup = {
  chainId: number;
  deploymentAddress: string;
  networkName: string;
  version: string | null;
  retiredAt: number | null;
  /** ADR 0022 — old circuit vk matches the bundled one ⇒ Withdraw offered. */
  withdrawable: boolean;
  assets: AssetTotal[];
};

type Props = {
  /** Present once the wallet is unlocked on this device — required to sign a
   *  withdrawal. Absent ⇒ history stays read-only. */
  addresses?: { evm: string; envelope: string; poseidon: string };
};

function shortContract(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatRetiredDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function RetiredNotesHistory({ addresses }: Props) {
  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () =>
    getNotesSnapshot(),
  );
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const archived = useQuery(api.shieldQueue.store.listArchivedDeployments, {});
  const tokens = useQuery(api.catalog.tokens.list, {});

  const [withdrawPayload, setWithdrawPayload] =
    useState<RetiredWithdrawPayload | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const groups = useMemo<RetiredGroup[]>(() => {
    if (!deployments) return [];

    const networkNameByChain = new Map<number, string>();
    for (const d of deployments) networkNameByChain.set(d.chainId, d.networkName);

    // (chainId:address) → marker fields, incl. the ADR-0022 withdraw gate.
    const markerByKey = new Map<
      string,
      { version: string | null; retiredAt: number; circuitVkHash?: string }
    >();
    for (const a of archived ?? []) {
      markerByKey.set(`${a.chainId}:${a.pampalo.toLowerCase()}`, {
        version: a.version ?? null,
        retiredAt: a.retiredAt,
        circuitVkHash: a.circuitVkHash,
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
          withdrawable: marker
            ? isRetiredDeploymentWithdrawable(marker)
            : false,
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
          notes: [],
        };
        g.assets.push(at);
      }
      at.amount += BigInt(n.amount);
      at.notes.push({
        asset: assetLower,
        amount: n.amount,
        secret: n.secret,
        owner: n.owner,
        leafCommitment: n.leafCommitment,
        leafIndex: n.leafIndex,
      });
    }

    return [...byDeployment.values()].sort(
      (a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0),
    );
  }, [notes, deployments, archived, tokens]);

  if (groups.length === 0) return null;

  const openWithdraw = (g: RetiredGroup, a: AssetTotal) => {
    setWithdrawPayload({
      chainId: g.chainId,
      deploymentAddress: g.deploymentAddress,
      asset: a.asset,
      symbol: a.symbol,
      decimals: a.decimals,
      notes: a.notes,
    });
    setSheetOpen(true);
  };

  return (
    <section className="rise-in rounded-3xl card-cream px-5 py-5">
      <div className="mb-1 flex items-center gap-2">
        <History className="size-4 text-ink-mute" />
        <p className="eyebrow">Previous deployments</p>
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-soft">
        Balances you held on an earlier contract version. They can’t be spent
        privately on the current contract, but you can{" "}
        <em>withdraw them to your wallet</em> — then re-shield on the current
        contract to hold funds privately again.
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
            <ul className="flex flex-col gap-1.5">
              {g.assets.map((a) => (
                <li
                  key={a.asset}
                  className={cn(
                    "flex items-center justify-between gap-3",
                    "text-[14px] text-ink-soft",
                  )}
                >
                  <span className="font-medium text-ink">{a.symbol}</span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums">
                      {formatUnits(a.amount, a.decimals)}
                    </span>
                    {g.withdrawable && addresses && (
                      <button
                        type="button"
                        onClick={() => openWithdraw(g, a)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full",
                          "border border-line bg-paper-lo px-3 py-1",
                          "text-[12px] font-semibold text-ink",
                          "transition-colors hover:bg-card",
                        )}
                      >
                        <Sun className="size-3" aria-hidden />
                        Withdraw
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {!g.withdrawable && (
              <p className="mt-2 text-[11.5px] text-ink-mute">
                Read-only — this contract was redeployed with a circuit change,
                so these notes can’t be withdrawn here.
              </p>
            )}
          </div>
        ))}
      </div>

      {addresses && (
        <RetiredWithdrawSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          payload={withdrawPayload}
          addresses={addresses}
        />
      )}
    </section>
  );
}

// Re-export the type for any caller that wants to render a subset.
export type { RetiredGroup };

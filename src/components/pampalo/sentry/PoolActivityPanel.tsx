import { useMemo } from "react";
import { formatUnits } from "ethers";
import { useQuery } from "convex/react";
import {
  ArrowLeftRight,
  ExternalLink,
  ShieldCheck,
  Sun,
  Waves,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { txUrl } from "@/lib/explorer";
import { cn } from "@/lib/utils";
import type { NetworkFilter } from "@/components/pampalo/NetworkFilterTabs";
import {
  NetworkChip,
  networkSlugForChainId,
} from "@/components/pampalo/NetworkChip";

// Pool-activity explorer for /sentry (TRANSFERS.md §9.5). A classified feed
// of private spends — transfers (note→note) and withdrawals (unshield) —
// from `shieldQueue.store.recentActivity`. Shields live in the queue above,
// not here. Everything shown is public on-chain material: type, time, the
// broadcaster's relayer attribution, the tx link, and a shortened ECIES
// payload preview. The private interior (amounts, owners) is never shown.

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-3xl card-cream p-4 sm:p-5">
      <header className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--priv-soft)] text-[var(--priv)]"
          aria-hidden
        >
          <Waves className="size-4" />
        </span>
        <div>
          <h2 className="font-serif text-[16px] font-bold text-ink">
            Pool activity
          </h2>
          <p className="text-[11.5px] text-ink-mute">
            Confirmed deposits, private transfers &amp; withdrawals. Deposit
            amounts are public; transfer &amp; withdrawal interiors stay hidden
            on-chain.
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

export function PoolActivityPanel({ filter }: { filter: NetworkFilter }) {
  const activity = useQuery(api.shieldQueue.store.recentActivity, { limit: 50 });
  const tokens = useQuery(api.catalog.tokens.list, {});
  const tokenMap = useMemo(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();
    for (const t of tokens ?? [])
      m.set(`${t.chainId}:${t.address.toLowerCase()}`, {
        symbol: t.symbol,
        decimals: t.decimals,
      });
    return m;
  }, [tokens]);
  if (activity === undefined) return null;

  // Confirmed deposits show a public amount (the ShieldQueued event); fall
  // back to raw base units if the token isn't in the catalog.
  const fmtAmount = (chainId: number, asset: string, amount: string): string => {
    const t = tokenMap.get(`${chainId}:${asset.toLowerCase()}`);
    if (!t) return amount;
    const n = Number(formatUnits(amount, t.decimals));
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${t.symbol}`;
  };

  const rows =
    filter === "all"
      ? activity
      : activity.filter((a) => a.chainId === filter);

  if (rows.length === 0) {
    // Nothing yet — keep the panel present (with an empty state) only when a
    // specific sponsoring-ish chain is selected; hide entirely on "all" so a
    // fresh deployment's sentry stays focused on the queue.
    if (filter === "all") return null;
    return (
      <PanelShell>
        <p className="rounded-2xl border border-line bg-paper-lo px-4 py-3 text-[12.5px] text-ink-soft">
          No pool activity on this network yet.
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const isTransfer = r.kind === "transfer";
          const isShield = r.kind === "shield";
          const isUnshield = r.kind === "unshield";
          const label = isShield
            ? "Deposit"
            : isTransfer
              ? "Private transfer"
              : "Withdrawal";
          const slug = networkSlugForChainId(r.chainId);
          const url = txUrl(r.chainId, r.txHash);
          return (
            <li
              key={`${r.chainId}:${r.txHash}`}
              className="flex flex-col gap-2 rounded-2xl border border-line bg-paper-lo px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              {/* Type + provenance */}
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    "inline-flex size-7 shrink-0 items-center justify-center rounded-lg",
                    isUnshield
                      ? "bg-[var(--pub-soft)] text-[var(--pub)]"
                      : "bg-[var(--priv-soft)] text-[var(--priv)]",
                  )}
                  aria-hidden
                >
                  {isShield ? (
                    <ShieldCheck className="size-3.5" />
                  ) : isTransfer ? (
                    <ArrowLeftRight className="size-3.5" />
                  ) : (
                    <Sun className="size-3.5" />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">
                      {label}
                    </span>
                    {filter === "all" && slug && <NetworkChip network={slug} />}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-mute">
                    <span>{timeAgo(r.blockTime * 1000)}</span>
                    {isShield ? (
                      <>
                        {r.asset && r.amount && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono text-ink-soft">
                              {fmtAmount(r.chainId, r.asset, r.amount)}
                            </span>
                          </>
                        )}
                        {r.shielder && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono">
                              from {r.shielder.slice(0, 6)}…
                              {r.shielder.slice(-4)}
                            </span>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <span aria-hidden>·</span>
                        {r.relayerIndex !== null ? (
                          <span className="inline-flex items-center rounded-full bg-paper px-1.5 py-0.5 font-semibold text-ink-soft">
                            via relayer #{r.relayerIndex}
                          </span>
                        ) : (
                          <span>self-broadcast</span>
                        )}
                        {r.payloadPreview && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono">
                              payload {r.payloadPreview}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Explorer link */}
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 self-start rounded-full",
                    "border border-line bg-transparent px-2.5 py-1 font-mono text-[11px]",
                    "text-ink-soft transition-colors hover:bg-paper hover:text-ink sm:self-auto",
                  )}
                  title="View transaction on block explorer"
                >
                  {r.txHash.slice(0, 8)}…{r.txHash.slice(-6)}
                  <ExternalLink className="size-3 opacity-70" aria-hidden />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </PanelShell>
  );
}

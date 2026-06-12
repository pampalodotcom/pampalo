import { useQuery } from "convex/react";
import { formatUnits } from "ethers";
import { AlertTriangle, Check, Copy, ExternalLink, Fuel } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { addressUrl, txUrl } from "@/lib/explorer";
import { useClipboard } from "@/lib/use-clipboard";
import { cn } from "@/lib/utils";
import type { NetworkFilter } from "@/components/pampalo/NetworkFilterTabs";
import {
  NetworkChip,
  networkSlugForChainId,
} from "@/components/pampalo/NetworkChip";

// "Gas sponsors" panel for /sentry (TRANSFERS.md §7). Public read over
// `relayer.store.listRelayerAccounts` — all public on-chain material, no
// userId linkage. Shows the relayer pool's funding + activity so the
// operator knows when to refill. Sits above the shield queue.
//
// v1: sponsoring chains are native-ETH (Base Sepolia), so balances are
// formatted as ETH/18. A multi-token-gas chain would read nativeSymbol
// off the deployment; flagged when that lands.

function shortAddr(addr: string): string {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtEth(wei: string): string {
  try {
    return `${Number(formatUnits(wei, 18)).toFixed(4)} ETH`;
  } catch {
    return "— ETH";
  }
}

function AddressCell({ address, chainId }: { address: string; chainId: number }) {
  const { copied, copy } = useClipboard();
  const url = addressUrl(chainId, address);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[12.5px] text-ink">
        {shortAddr(address)}
      </span>
      <button
        type="button"
        onClick={() => void copy(address)}
        aria-label={copied ? "Address copied" : "Copy relayer address"}
        title={copied ? "Copied" : "Copy address"}
        className={cn(
          "inline-flex size-5 items-center justify-center rounded",
          "text-ink-mute transition-colors hover:bg-paper hover:text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
          copied && "text-[var(--pub)]",
        )}
      >
        {copied ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View relayer on block explorer"
          title="View on block explorer"
          className={cn(
            "inline-flex size-5 items-center justify-center rounded",
            "text-ink-mute transition-colors hover:bg-paper hover:text-ink",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
          )}
        >
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </span>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-3xl card-cream p-4 sm:p-5">
      <header className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--pub-soft)] text-[var(--pub)]"
          aria-hidden
        >
          <Fuel className="size-4" />
        </span>
        <div>
          <h2 className="font-serif text-[16px] font-bold text-ink">
            Gas sponsors
          </h2>
          <p className="text-[11.5px] text-ink-mute">
            Relayer accounts that broadcast private transfers &amp; withdrawals
            so your address never signs.
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

export function GasSponsorsPanel({ filter }: { filter: NetworkFilter }) {
  const accounts = useQuery(api.relayer.store.listRelayerAccounts, {});

  // Still loading — render nothing rather than flash a skeleton above the
  // queue. The panel is supplementary.
  if (accounts === undefined) return null;

  // No sponsoring chains configured anywhere → hide entirely (§7.3).
  if (accounts.length === 0) return null;

  const rows =
    filter === "all"
      ? accounts
      : accounts.filter((a) => a.chainId === filter);

  // Group by chain so each network's relayer pool is labelled with its
  // own header — otherwise the "all" view interleaves identical-looking
  // rows from different chains with no way to tell them apart. Insertion
  // order is preserved (first-seen chain stays first).
  const groups: { chainId: number; items: typeof rows }[] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.chainId === r.chainId);
    if (!g) {
      g = { chainId: r.chainId, items: [] };
      groups.push(g);
    }
    g.items.push(r);
  }

  // A specific chip that isn't a sponsoring chain → honest empty state.
  if (rows.length === 0) {
    return (
      <PanelShell>
        <p className="rounded-2xl border border-line bg-paper-lo px-4 py-3 text-[12.5px] text-ink-soft">
          Pampalo doesn&apos;t sponsor transfers on this network. Users
          broadcast from their own wallets here.
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <div className="flex flex-col gap-4">
        {groups.map((g) => {
          const slug = networkSlugForChainId(g.chainId);
          return (
            <section key={g.chainId} className="flex flex-col gap-2">
              {/* Network header — names the chain this relayer pool runs on. */}
              <div className="flex items-center gap-2 px-0.5">
                {slug ? (
                  <NetworkChip network={slug} />
                ) : (
                  <span className="net-chip">Chain {g.chainId}</span>
                )}
                <span className="text-[11px] text-ink-mute">
                  {g.items.length} relayer{g.items.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {g.items.map((r) => (
                  <li
                    key={`${r.chainId}:${r.accountIndex}`}
                    className={cn(
                      "flex flex-col gap-2 rounded-2xl border px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between",
                      r.lowBalance
                        ? "border-[var(--pub-soft-2)] bg-[var(--pub-soft)]"
                        : "border-line bg-paper-lo",
                    )}
                  >
                    {/* Identity */}
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-paper px-1.5 font-mono text-[11px] font-semibold text-ink-soft">
                        #{r.accountIndex}
                      </span>
                      <AddressCell address={r.address} chainId={r.chainId} />
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]",
                          r.busy
                            ? "bg-[var(--priv-soft)] text-[var(--priv)]"
                            : "bg-paper text-ink-mute",
                        )}
                      >
                        {r.busy ? "Busy" : "Idle"}
                      </span>
                      {r.lowBalance && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--pub)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white">
                          <AlertTriangle className="size-2.5" aria-hidden />
                          Refill
                        </span>
                      )}
                    </div>

                    {/* Balance + last activity */}
                    <div className="flex items-center justify-between gap-4 sm:justify-end">
                      <span
                        className="font-mono text-[13px] font-semibold text-ink"
                        title={`Updated ${timeAgo(r.balanceUpdatedAt)}${
                          r.balanceLastReconciledAt
                            ? ` · reconciled ${timeAgo(r.balanceLastReconciledAt)}`
                            : ""
                        }`}
                      >
                        {fmtEth(r.balanceWei)}
                      </span>
                      <span className="font-mono text-[11px] text-ink-mute">
                        {r.lastBroadcastAt === null ? (
                          "no broadcasts yet"
                        ) : r.lastTxHash ? (
                          <a
                            href={txUrl(r.chainId, r.lastTxHash) ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
                            title="View last broadcast on block explorer"
                          >
                            Last {timeAgo(r.lastBroadcastAt)}
                            <ExternalLink
                              className="size-3 opacity-70"
                              aria-hidden
                            />
                          </a>
                        ) : (
                          `Last ${timeAgo(r.lastBroadcastAt)}`
                        )}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </PanelShell>
  );
}

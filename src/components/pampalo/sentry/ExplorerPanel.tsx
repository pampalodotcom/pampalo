import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "ethers";
import { useQuery } from "convex/react";
import {
  ExternalLink,
  Search,
  ShieldAlert,
  ShieldCheck,
  Leaf,
  ArrowLeftRight,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { txUrl } from "@/lib/explorer";
import { cn } from "@/lib/utils";
import type { NetworkFilter } from "@/components/pampalo/NetworkFilterTabs";
import {
  NetworkChip,
  networkSlugForChainId,
} from "@/components/pampalo/NetworkChip";

// /sentry block explorer. One smart box: a 40-hex string is an address
// (→ that address's shields + compliance-flag status); a 64-hex string is
// ambiguous between a txHash and a leaf commitment, so we query BOTH and
// show whatever matches. Lookups are global (all chains); results are then
// narrowed to the page's network filter. Everything shown is public
// on-chain material — see the store.ts lookup queries.

const ADDR_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;

function shortHex(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-3xl card-cream p-4 sm:p-5">
      <header className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--priv-soft)] text-[var(--priv)]"
          aria-hidden
        >
          <Search className="size-4" />
        </span>
        <div>
          <h2 className="font-serif text-[16px] font-bold text-ink">
            Block explorer
          </h2>
          <p className="text-[11.5px] text-ink-mute">
            Look up an address, transaction, or leaf hash. Address search also
            shows whether Pampalo has flagged the account.
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

function Net({ chainId }: { chainId: number }) {
  const slug = networkSlugForChainId(chainId);
  if (!slug) return <span className="text-[11px] text-ink-mute">#{chainId}</span>;
  return <NetworkChip network={slug} />;
}

function TxLink({ chainId, txHash }: { chainId: number; txHash: string }) {
  const url = txUrl(chainId, txHash);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-ink-mute transition-colors hover:text-ink"
      aria-label="View transaction"
    >
      <span className="font-mono text-[11px]">{shortHex(txHash)}</span>
      <ExternalLink className="size-3" />
    </a>
  );
}

function RowShell({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-line bg-paper-lo px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-card text-ink-soft">
          {icon}
        </span>
        <div className="min-w-0">{children}</div>
      </div>
    </li>
  );
}

export function ExplorerPanel({ filter }: { filter: NetworkFilter }) {
  const [raw, setRaw] = useState("");
  const [q, setQ] = useState("");

  // Debounce typing into the query that actually fires the lookups.
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [raw]);

  const isAddr = ADDR_RE.test(q);
  const isHash = HASH_RE.test(q);
  const invalid = q.length > 0 && !isAddr && !isHash;

  const addrShields = useQuery(
    api.shieldQueue.store.lookupByAddress,
    isAddr ? { address: q } : "skip",
  );
  const flags = useQuery(
    api.compliance.store.flagsForAddress,
    isAddr ? { address: q } : "skip",
  );
  const txRes = useQuery(
    api.shieldQueue.store.lookupByTxHash,
    isHash ? { txHash: q } : "skip",
  );
  const leafRes = useQuery(
    api.shieldQueue.store.lookupByLeaf,
    isHash ? { leafCommitment: q } : "skip",
  );
  const tokens = useQuery(api.catalog.tokens.list, {});

  const tokenMap = useMemo(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();
    for (const t of tokens ?? []) {
      m.set(`${t.chainId}:${t.address.toLowerCase()}`, {
        symbol: t.symbol,
        decimals: t.decimals,
      });
    }
    return m;
  }, [tokens]);

  const fmtAmount = (chainId: number, asset: string, amount: string) => {
    const t = tokenMap.get(`${chainId}:${asset.toLowerCase()}`);
    if (!t) return `${amount} ${shortHex(asset)}`;
    const n = Number(formatUnits(amount, t.decimals));
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${t.symbol}`;
  };

  const inFilter = (chainId: number) => filter === "all" || chainId === filter;

  // Merge + dedupe shields (a 64-hex hash can match both the tx and the
  // leaf query, returning the same shield twice).
  const shields = useMemo(() => {
    const all = [
      ...(isAddr ? (addrShields ?? []) : []),
      ...(isHash ? (txRes?.shields ?? []) : []),
      ...(isHash ? (leafRes?.shields ?? []) : []),
    ].filter((s) => inFilter(s.chainId));
    const seen = new Set<string>();
    return all.filter((s) => {
      const key = `${s.chainId}:${s.pendingId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [isAddr, isHash, addrShields, txRes, leafRes, filter]);

  const activity = (isHash ? (txRes?.activity ?? []) : []).filter((a) =>
    inFilter(a.chainId),
  );
  const leaves = (isHash ? (leafRes?.leaves ?? []) : []).filter((l) =>
    inFilter(l.chainId),
  );
  const flagList = isAddr ? (flags ?? []) : [];

  const loading =
    (isAddr && (addrShields === undefined || flags === undefined)) ||
    (isHash && (txRes === undefined || leafRes === undefined));

  const noHashMatch =
    isHash && shields.length === 0 && activity.length === 0 && leaves.length === 0;

  return (
    <PanelShell>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-mute" />
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… address, tx hash, or leaf hash"
          className={cn(
            "w-full rounded-full border border-line bg-card py-2.5 pl-9 pr-3",
            "font-mono text-[13px] text-ink placeholder:text-ink-mute",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
          )}
        />
      </div>

      {invalid && (
        <p className="mt-3 rounded-2xl border border-line bg-paper-lo px-4 py-3 text-[12.5px] text-ink-soft">
          Enter an EVM address (0x + 40 hex), a transaction hash, or a leaf
          hash (0x + 64 hex).
        </p>
      )}

      {(isAddr || isHash) && loading && (
        <p className="mt-3 px-1 text-[12.5px] text-ink-mute">Searching…</p>
      )}

      {(isAddr || isHash) && !loading && (
        <div className="mt-3 flex flex-col gap-3">
          {/* Compliance flags — loud, since this is the "known bad actor?"
              answer the user came for. */}
          {flagList.length > 0 && (
            <div className="rounded-2xl border border-warn-bd bg-warn-bg px-4 py-3">
              <div className="mb-1 flex items-center gap-2 text-warn-fg">
                <ShieldAlert className="size-4" />
                <span className="text-[13px] font-bold">
                  Flagged by Pampalo compliance
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {flagList.map((f, i) => (
                  <li
                    key={`${f.source}-${i}`}
                    className="text-[12px] text-ink-soft"
                  >
                    <span className="font-semibold uppercase text-ink">
                      {f.source}
                    </span>{" "}
                    · {f.reason} · added {fmtDate(f.addedAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isAddr &&
            flags !== undefined &&
            addrShields !== undefined &&
            flagList.length === 0 && (
            <div className="rounded-2xl border border-line bg-paper-lo px-4 py-2.5">
              <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-soft">
                <ShieldCheck className="size-4 text-[var(--priv)]" />
                Not on Pampalo’s compliance blocklist.
              </span>
            </div>
          )}

          {shields.length > 0 && (
            <ul className="flex flex-col gap-2">
              {shields.map((s) => (
                <RowShell
                  key={`s-${s.chainId}-${s.pendingId}`}
                  icon={<ShieldCheck className="size-4" />}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink">
                    <span className="font-semibold">
                      {fmtAmount(s.chainId, s.asset, s.amount)}
                    </span>
                    <span className="rounded-full bg-card px-2 py-0.5 text-[10.5px] font-semibold uppercase text-ink-mute">
                      {s.state}
                    </span>
                    <Net chainId={s.chainId} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
                    <span className="font-mono">
                      shielder {shortHex(s.shielder)}
                    </span>
                    <TxLink chainId={s.chainId} txHash={s.queuedTxHash} />
                    <span className="font-mono">
                      leaf {shortHex(s.leafCommitment)}
                    </span>
                  </div>
                </RowShell>
              ))}
            </ul>
          )}

          {activity.length > 0 && (
            <ul className="flex flex-col gap-2">
              {activity.map((a) => (
                <RowShell
                  key={`a-${a.chainId}-${a.txHash}`}
                  icon={<ArrowLeftRight className="size-4" />}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink">
                    <span className="font-semibold capitalize">{a.kind}</span>
                    <Net chainId={a.chainId} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
                    <span>{fmtDate(a.blockTime * 1000)}</span>
                    <span className="font-mono">from {shortHex(a.from)}</span>
                    <TxLink chainId={a.chainId} txHash={a.txHash} />
                  </div>
                </RowShell>
              ))}
            </ul>
          )}

          {leaves.length > 0 && (
            <ul className="flex flex-col gap-2">
              {leaves.map((l) => (
                <RowShell
                  key={`l-${l.chainId}-${l.leafCommitment}`}
                  icon={<Leaf className="size-4" />}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink">
                    <span className="font-semibold">
                      Leaf #{l.leafIndex}
                    </span>
                    <span className="text-[11px] text-ink-mute">
                      epoch {l.epoch}
                    </span>
                    <Net chainId={l.chainId} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
                    <TxLink chainId={l.chainId} txHash={l.insertedTxHash} />
                  </div>
                </RowShell>
              ))}
            </ul>
          )}

          {noHashMatch && (
            <p className="rounded-2xl border border-line bg-paper-lo px-4 py-3 text-[12.5px] text-ink-soft">
              No transaction or leaf matches that hash
              {filter === "all" ? "" : " on this network"}.
            </p>
          )}
        </div>
      )}
    </PanelShell>
  );
}

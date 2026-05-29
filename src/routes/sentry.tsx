import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import {
  Check,
  Clock3,
  Copy,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  Wrench,
  Zap,
} from "lucide-react";
import { formatUnits } from "ethers";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { AccountAvatar } from "@/components/pampalo/AccountAvatar";
import { AssetMark } from "@/components/pampalo/AssetMark";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { BrandLockup } from "@/components/pampalo/BrandLockup";
import { NetworkLogo } from "@/components/pampalo/deposit/NetworkLogo";
import {
  NetworkFilterTabs,
  type NetworkFilter,
  type NetworkOption,
} from "@/components/pampalo/NetworkFilterTabs";
import {
  ActionConfirmSheet,
  type ActionConfirmPayload,
} from "@/components/pampalo/sentry/ActionConfirmSheet";
import {
  ContestSheet,
  type ContestPayload,
} from "@/components/pampalo/sentry/ContestSheet";
import { ThemeToggle } from "@/components/pampalo/ThemeToggle";
import { useAccountModal } from "@/lib/account-modal";
import { useAuth } from "@/lib/auth";
import { useClipboard } from "@/lib/use-clipboard";
import {
  useDeploymentRoles,
  type DeploymentRoles,
} from "@/lib/use-deployment-roles";
import { addressUrl, txUrl } from "@/lib/explorer";
import { useIsDesktop } from "@/lib/use-media-query";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Public shield-queue surveillance surface — see SHIELD_FLOW.md §10.
// Anonymous viewers see the queue; signed-in viewers can Contest /
// Sponsor finalise / Fast-track based on their on-chain role
// membership. Data source = Convex `shieldQueueEntries` (no IDB).

export const Route = createFileRoute("/sentry")({ component: Sentry });

const PAGE_SIZE = 50;
const REFRESH_THROTTLE_MS = 5000;

type ShieldQueueEntry = Doc<"shieldQueueEntries">;
type Deployment = NonNullable<
  ReturnType<typeof useDeploymentsList>
>[number];

function useDeploymentsList() {
  return useQuery(api.shieldQueue.store.enabledDeployments, {});
}

function Sentry() {
  const auth = useAuth();
  const accountModal = useAccountModal();
  const { theme } = useTheme();
  const isDesktop = useIsDesktop();

  const deployments = useDeploymentsList();
  const tokens = useQuery(api.catalog.tokens.list, {});
  const [filter, setFilter] = useState<NetworkFilter>("all");

  // Rows the user just submitted a finalise tx for. The row stays in
  // the `queued` Convex view until the indexer flips it to `executed`
  // (~30s), so without this transition state the row would just sit
  // there with action buttons until it vanished. We treat the user's
  // own broadcast as authoritative — once they submit, we render a
  // "Finalising…" pill and hide the buttons.
  const [finalising, setFinalising] = useState<Set<string>>(new Set());
  const markFinalising = (rowId: string) => {
    setFinalising((prev) => {
      const next = new Set(prev);
      next.add(rowId);
      return next;
    });
  };

  // ─── Role detection per deployment ───────────────────────────────
  // Each deployment renders a RoleProbe that calls useDeploymentRoles
  // once and reports back via callback. Keeps hooks-rules happy when
  // the deployments list updates reactively. See SHIELD_FLOW.md §10.4.
  const evmAddress =
    auth.state.status === "authenticated" && auth.state.addresses
      ? auth.state.addresses.evm
      : null;
  const [rolesByChainId, setRolesByChainId] = useState<
    Map<number, DeploymentRoles>
  >(new Map());

  const onRolesForChain = (
    chainId: number,
    roles: DeploymentRoles | null,
  ): void => {
    setRolesByChainId((prev) => {
      const next = new Map(prev);
      if (roles === null) next.delete(chainId);
      else next.set(chainId, roles);
      return next;
    });
  };

  // Sheet payloads — null when closed.
  const [contestPayload, setContestPayload] =
    useState<ContestPayload | null>(null);
  const [actionPayload, setActionPayload] =
    useState<ActionConfirmPayload | null>(null);

  // Build filter options from enabled deployments. v1 ships with just
  // Base Sepolia so this is "All" + 1 chip; the same code handles
  // multi-deployment configs without changes.
  const filterOptions: NetworkOption[] = useMemo(() => {
    const base: NetworkOption[] = [{ value: "all", label: "All" }];
    if (!deployments) return base;
    return base.concat(
      deployments.map((d) => ({
        value: d.chainId,
        label: d.networkName,
      })),
    );
  }, [deployments]);

  // Resolve the filter chip to a deploymentId for the paginated query.
  // "all" → undefined → cross-deployment via the new by_state index.
  const deploymentId = useMemo<Id<"pampaloDeployments"> | undefined>(() => {
    if (filter === "all") return undefined;
    if (!deployments) return undefined;
    return deployments.find((d) => d.chainId === filter)?._id;
  }, [filter, deployments]);

  const paginated = usePaginatedQuery(
    api.shieldQueue.store.queue,
    {
      state: "queued",
      deploymentId,
    },
    { initialNumItems: PAGE_SIZE },
  );

  // Manual refresh — calls the existing one-shot indexer action.
  // 5s client-side throttle so a stuck user can't hammer the cron.
  const refresh = useAction(
    api.shieldQueue.refresh.refreshShieldQueueNow,
  );
  const [refreshing, setRefreshing] = useState(false);
  const lastRefreshAtRef = useRef<number | null>(null);

  const onRefresh = async () => {
    if (refreshing) return;
    const last = lastRefreshAtRef.current;
    if (last !== null && Date.now() - last < REFRESH_THROTTLE_MS) {
      toast("Slow down — refreshes throttled to 5s");
      return;
    }
    setRefreshing(true);
    try {
      await refresh();
      lastRefreshAtRef.current = Date.now();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Refresh failed";
      toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main className="phone-shell flex flex-1 flex-col">
      {/* ─── Header band ───────────────────────────────────────────── */}
      <div className="relative shrink-0 w-full">
        <BeachScene height={220} theme={theme} />
        <div className="absolute inset-x-0 top-6 z-10 pointer-events-none">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-5">
            <Link
              to="/"
              aria-label="Pampalo home"
              className="pointer-events-auto flex items-center gap-2 rounded-md transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15"
            >
              <BrandLockup />
            </Link>
            <div className="pointer-events-auto flex items-center gap-2">
              <ThemeToggle />
              {evmAddress && (
                <button
                  type="button"
                  onClick={accountModal.open}
                  aria-label="Open account menu"
                  className={cn(
                    "inline-flex items-center justify-center",
                    "rounded-full transition-transform hover:scale-105",
                    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15",
                  )}
                >
                  <AccountAvatar address={evmAddress} size={32} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Main column ───────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-5xl px-4 pb-12 sm:px-6">
        <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2">
              <span
                className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--priv-soft)] text-[var(--priv)]"
                aria-hidden
              >
                <ShieldAlert className="size-4" />
              </span>
              <h1 className="font-serif text-[22px] font-bold text-ink">
                Shield queue
              </h1>
            </div>
            <p className="mt-1 text-[12.5px] text-ink-mute">
              Pending shields across every Pampalo deployment. Vigilant
              citizens contest; anyone can sponsor a finalise after the
              wait expires.
            </p>
          </div>

          <NetworkFilterTabs
            value={filter}
            options={filterOptions}
            onChange={setFilter}
            className="hidden md:inline-flex"
          />
          <NetworkFilterTabs
            value={filter}
            options={filterOptions}
            onChange={setFilter}
            appearance="badges"
            className="md:hidden"
          />
        </header>

        {/* ─── Auth banner ────────────────────────────────────────── */}
        {auth.state.status !== "authenticated" && (
          <div
            className={cn(
              "mb-4 rounded-2xl border border-line bg-paper-lo px-4 py-3",
              "text-[12.5px] text-ink-soft",
            )}
          >
            Viewing as a guest. Sign in with your passkey to contest,
            sponsor, or fast-track shields.
          </div>
        )}

        {/* ─── Role chips ─────────────────────────────────────────── */}
        {auth.state.status === "authenticated" && (
          <MyRolesRow
            deployments={deployments ?? []}
            rolesByChainId={rolesByChainId}
          />
        )}

        {/* ─── Queue body ─────────────────────────────────────────── */}
        <QueueBody
          isDesktop={isDesktop}
          status={paginated.status}
          results={paginated.results}
          deployments={deployments ?? []}
          tokens={tokens ?? []}
          finalising={finalising}
          authed={auth.state.status === "authenticated"}
          rolesByChainId={rolesByChainId}
          onContest={(row) => setContestPayload({ row })}
          onSponsor={(row) =>
            setActionPayload({ kind: "sponsor", row })
          }
          onFastTrack={(row) =>
            setActionPayload({ kind: "fastTrack", row })
          }
        />

        {/* Invisible role probes — one per enabled deployment. They
            keep `rolesByChainId` populated for the authed user via the
            hasRoles eth_call. No-op when unauthed. */}
        {evmAddress &&
          (deployments ?? []).map((d) => (
            <RoleProbe
              key={d._id}
              chainId={d.chainId}
              user={evmAddress}
              onChange={(roles) => onRolesForChain(d.chainId, roles)}
            />
          ))}

        {/* ─── Footer: refresh + load more ────────────────────────── */}
        <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full",
              "border border-line bg-transparent px-4",
              "text-[12.5px] font-semibold text-ink-soft",
              "transition-colors hover:bg-paper-lo",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCcw className="size-3.5" aria-hidden />
            )}
            Refresh
          </button>

          {paginated.status === "CanLoadMore" && (
            <button
              type="button"
              onClick={() => paginated.loadMore(PAGE_SIZE)}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-full",
                "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
                "px-5 text-[13px] font-bold text-white shadow-sm",
              )}
            >
              Load more
            </button>
          )}

          {paginated.status === "LoadingMore" && (
            <span className="inline-flex items-center gap-2 text-[12px] text-ink-mute">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading more…
            </span>
          )}

          {paginated.status === "Exhausted" &&
            paginated.results.length > 0 && (
              <span className="text-[12px] text-ink-mute">
                Showing all {paginated.results.length} queued shields.
              </span>
            )}
        </div>
      </section>

      {/* ─── Action sheets (lifted to the page so they survive row
              remounts when the reactive query reshuffles results) ── */}
      <ContestSheet
        open={contestPayload !== null}
        onOpenChange={(next) => {
          if (!next) setContestPayload(null);
        }}
        payload={contestPayload}
        evmAddress={evmAddress}
        deployments={deployments ?? []}
      />
      <ActionConfirmSheet
        open={actionPayload !== null}
        onOpenChange={(next) => {
          if (!next) setActionPayload(null);
        }}
        payload={actionPayload}
        evmAddress={evmAddress}
        deployments={deployments ?? []}
        onSubmitted={(rowId) => {
          markFinalising(rowId);
          // Nudge the indexer — the cron picks the event up within 30s
          // on its own, but a manual refresh shortens the gap between
          // "user submitted" and "row drops out of the queue".
          void refresh().catch(() => undefined);
        }}
      />
    </main>
  );
}

// Invisible component: calls useDeploymentRoles once and reports the
// resolved roles up. Lets the page render N probes in a loop without
// breaking the rules-of-hooks (the loop is over a stable list of
// deployment components — each component holds exactly one hook).
function RoleProbe({
  chainId,
  user,
  onChange,
}: {
  chainId: number;
  user: string;
  onChange: (roles: DeploymentRoles | null) => void;
}) {
  const roles = useDeploymentRoles(chainId, user);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    cb.current(roles);
  }, [roles]);
  return null;
}

// ─── Role chips ─────────────────────────────────────────────────────────
// Discreet inline row under the page header showing which Pampalo
// roles the signed-in user holds, aggregated across all enabled
// deployments. Rendered nothing when the user has no roles on any
// chain — the absence is the answer.

function MyRolesRow({
  deployments,
  rolesByChainId,
}: {
  deployments: Array<{ chainId: number; networkName: string }>;
  rolesByChainId: Map<number, DeploymentRoles>;
}) {
  const vigilantChains: string[] = [];
  const boothChains: string[] = [];
  for (const d of deployments) {
    const r = rolesByChainId.get(d.chainId);
    if (!r) continue;
    if (r.vigilantCitizen) vigilantChains.push(d.networkName);
    if (r.boothOperator) boothChains.push(d.networkName);
  }
  if (vigilantChains.length === 0 && boothChains.length === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-ink-mute">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        Your roles
      </span>
      {vigilantChains.length > 0 && (
        <RoleChip
          icon={<Eye className="size-3" />}
          label="Vigilant Citizen"
          chains={vigilantChains}
        />
      )}
      {boothChains.length > 0 && (
        <RoleChip
          icon={<Wrench className="size-3" />}
          label="Booth Operator"
          chains={boothChains}
        />
      )}
    </div>
  );
}

function RoleChip({
  icon,
  label,
  chains,
}: {
  icon: React.ReactNode;
  label: string;
  chains: string[];
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full",
        "border border-line bg-paper-lo/60 px-2 py-[3px]",
        "text-[11px] text-ink-soft",
      )}
      title={`${label} · ${chains.join(", ")}`}
    >
      <span className="text-ink-mute">{icon}</span>
      <span className="font-medium text-ink">{label}</span>
      <span className="text-ink-faint">· {chains.join(", ")}</span>
    </span>
  );
}

// ─── Body switcher: skeleton / empty / data ─────────────────────────────

type RowHandlers = {
  authed: boolean;
  rolesByChainId: Map<number, DeploymentRoles>;
  /** Convex `_id`s for rows the user has already submitted a finalise
   *  tx for. These rows render "Finalising…" instead of action
   *  buttons until the indexer flips them to executed (and the row
   *  falls out of the queued query). */
  finalising: Set<string>;
  onContest: (row: ShieldQueueEntry) => void;
  onSponsor: (row: ShieldQueueEntry) => void;
  onFastTrack: (row: ShieldQueueEntry) => void;
};

type TokenInfo = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
};

function QueueBody({
  isDesktop,
  status,
  results,
  deployments,
  tokens,
  finalising,
  authed,
  rolesByChainId,
  onContest,
  onSponsor,
  onFastTrack,
}: {
  isDesktop: boolean;
  status: ReturnType<typeof usePaginatedQuery>["status"];
  results: ShieldQueueEntry[];
  deployments: Deployment[];
  tokens: TokenInfo[];
} & Omit<RowHandlers, "rolesByChainId" | "finalising"> & {
    rolesByChainId: Map<number, DeploymentRoles>;
    finalising: Set<string>;
  }) {
  if (status === "LoadingFirstPage") {
    return <QueueSkeleton isDesktop={isDesktop} />;
  }
  if (results.length === 0) {
    return <QueueEmpty />;
  }
  const handlers: RowHandlers = {
    authed,
    rolesByChainId,
    finalising,
    onContest,
    onSponsor,
    onFastTrack,
  };
  if (isDesktop) {
    return (
      <QueueTable
        results={results}
        deployments={deployments}
        tokens={tokens}
        handlers={handlers}
      />
    );
  }
  return (
    <QueueCards
      results={results}
      deployments={deployments}
      tokens={tokens}
      handlers={handlers}
    />
  );
}

function QueueSkeleton({ isDesktop }: { isDesktop: boolean }) {
  if (isDesktop) {
    return (
      <div className="rounded-2xl border border-line bg-paper-lo p-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="skel my-2 block"
            style={{ height: 44, width: "100%", borderRadius: 12 }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="skel"
          style={{ height: 132, width: "100%", borderRadius: 22 }}
        />
      ))}
    </div>
  );
}

function QueueEmpty() {
  return (
    <div className="rounded-3xl card-cream px-6 py-10 text-center">
      <div className="text-[28px]" aria-hidden>
        🌴
      </div>
      <h2 className="mt-2 font-serif text-[18px] font-bold text-ink">
        No shields in the queue right now.
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[12.5px] text-ink-mute">
        Anything submitted to a Pampalo deployment will appear here
        within 30 seconds of confirming on-chain. The page updates
        automatically.
      </p>
    </div>
  );
}

// ─── Desktop table ──────────────────────────────────────────────────────

function QueueTable({
  results,
  deployments,
  tokens,
  handlers,
}: {
  results: ShieldQueueEntry[];
  deployments: Deployment[];
  tokens: TokenInfo[];
  handlers: RowHandlers;
}) {
  const deploymentChainById = useMemo(() => {
    const m = new Map<string, Deployment>();
    for (const d of deployments) m.set(d._id, d);
    return m;
  }, [deployments]);
  const tokenByChainAsset = useMemo(() => {
    const m = new Map<string, TokenInfo>();
    for (const t of tokens) {
      m.set(`${t.chainId}:${t.address.toLowerCase()}`, t);
    }
    return m;
  }, [tokens]);

  return (
    <div className="rounded-2xl border border-line bg-paper-lo p-2">
      <Table>
        <TableHeader>
          <TableRow className="border-line">
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
              Network
            </TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
              Shielder
            </TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
              Amount
            </TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
              Queued
            </TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
              Unlocks
            </TableHead>
            <TableHead className="text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((row) => {
            const dep = deploymentChainById.get(row.deploymentId);
            const token =
              dep
                ? tokenByChainAsset.get(
                    `${dep.chainId}:${row.asset.toLowerCase()}`,
                  )
                : undefined;
            return (
              <TableRow key={row._id} className="border-line">
                <TableCell className="text-[12px] text-ink">
                  <NetworkCell
                    chainId={dep?.chainId ?? null}
                    name={dep?.networkName ?? null}
                  />
                </TableCell>
                <TableCell className="text-[12px] text-ink">
                  <ShielderCell
                    address={row.shielder}
                    chainId={dep?.chainId ?? null}
                  />
                </TableCell>
                <TableCell className="text-[12px] text-ink">
                  <AmountCell amount={row.amount} token={token} />
                </TableCell>
                <TableCell className="text-[12px] text-ink-soft">
                  <QueuedCell
                    queuedAt={row.queuedAt}
                    chainId={dep?.chainId ?? null}
                    txHash={row.queuedTxHash}
                  />
                </TableCell>
                <TableCell className="font-mono text-[12px] text-ink-soft">
                  {unlockLabel(row.unlockTime)}
                </TableCell>
                <TableCell className="text-right">
                  <RowActions
                    row={row}
                    chainId={dep?.chainId ?? null}
                    handlers={handlers}
                    layout="row"
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Mobile card stack ──────────────────────────────────────────────────

function QueueCards({
  results,
  deployments,
  tokens,
  handlers,
}: {
  results: ShieldQueueEntry[];
  deployments: Deployment[];
  tokens: TokenInfo[];
  handlers: RowHandlers;
}) {
  const deploymentChainById = useMemo(() => {
    const m = new Map<string, Deployment>();
    for (const d of deployments) m.set(d._id, d);
    return m;
  }, [deployments]);
  const tokenByChainAsset = useMemo(() => {
    const m = new Map<string, TokenInfo>();
    for (const t of tokens) {
      m.set(`${t.chainId}:${t.address.toLowerCase()}`, t);
    }
    return m;
  }, [tokens]);

  return (
    <ul className="flex flex-col gap-3">
      {results.map((row) => {
        const dep = deploymentChainById.get(row.deploymentId);
        const token =
          dep
            ? tokenByChainAsset.get(
                `${dep.chainId}:${row.asset.toLowerCase()}`,
              )
            : undefined;
        return (
          <li key={row._id}>
            <div className="rounded-2xl card-cream p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <NetworkCell
                    chainId={dep?.chainId ?? null}
                    name={dep?.networkName ?? null}
                  />
                  <div className="mt-1.5">
                    <ShielderCell
                      address={row.shielder}
                      chainId={dep?.chainId ?? null}
                    />
                  </div>
                </div>
                <div className="text-right">
                  <AmountCell
                    amount={row.amount}
                    token={token}
                    alignRight
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11.5px] text-ink-mute">
                <QueuedCell
                  queuedAt={row.queuedAt}
                  chainId={dep?.chainId ?? null}
                  txHash={row.queuedTxHash}
                  prefix="Queued "
                />
                <span>{unlockLabel(row.unlockTime)}</span>
              </div>
              <div className="mt-3">
                <RowActions
                  row={row}
                  chainId={dep?.chainId ?? null}
                  handlers={handlers}
                  layout="card"
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Row cells ──────────────────────────────────────────────────────────

function NetworkCell({
  chainId,
  name,
}: {
  chainId: number | null;
  name: string | null;
}) {
  if (chainId === null) {
    return <span className="font-mono text-[12px] text-ink-mute">unknown</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <NetworkLogo chainId={chainId} size={18} />
      <span className="text-[12.5px] font-medium text-ink">
        {name ?? `chain ${chainId}`}
      </span>
    </span>
  );
}

function AmountCell({
  amount,
  token,
  alignRight,
}: {
  amount: string;
  token: TokenInfo | undefined;
  alignRight?: boolean;
}) {
  // Fall back gracefully when the token isn't in the catalog yet (the
  // catalog query is still loading, or the asset is brand new). We
  // still want the row to render rather than blank-out.
  const decimals = token?.decimals;
  const formatted =
    decimals !== undefined ? formatTokenAmount(amount, decimals) : amount;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        alignRight && "justify-end",
      )}
    >
      {token?.symbol && <AssetMark symbol={token.symbol} size={22} />}
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-[13px] font-semibold text-ink">
          {formatted}
          {token?.symbol && (
            <span className="ml-1 text-ink-soft">{token.symbol}</span>
          )}
        </span>
        {token?.name && (
          <span className="text-[10.5px] text-ink-mute">{token.name}</span>
        )}
      </span>
    </span>
  );
}

function ShielderCell({
  address,
  chainId,
}: {
  address: string;
  chainId: number | null;
}) {
  const { copied, copy } = useClipboard();
  const url = chainId !== null ? addressUrl(chainId, address) : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[12px] text-ink">
        {shortAddress(address)}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void copy(address);
        }}
        aria-label={copied ? "Address copied" : "Copy shielder address"}
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
          onClick={(e) => e.stopPropagation()}
          aria-label="View shielder on block explorer"
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

function QueuedCell({
  queuedAt,
  chainId,
  txHash,
  prefix,
}: {
  queuedAt: number;
  chainId: number | null;
  txHash: string;
  prefix?: string;
}) {
  const url = chainId !== null && txHash ? txUrl(chainId, txHash) : null;
  const label = (
    <span className="font-mono">
      {prefix}
      {timeAgo(queuedAt)}
    </span>
  );
  if (!url) return label;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="View shield transaction on block explorer"
      className={cn(
        "inline-flex items-center gap-1.5",
        "text-ink-soft transition-colors hover:text-ink",
      )}
    >
      {label}
      <ExternalLink className="size-3 opacity-70" aria-hidden />
    </a>
  );
}

// Format a base-units uint256 string into a short human-friendly decimal.
// 5dp for small-decimal assets like ETH; 2dp for stablecoin-sized things.
function formatTokenAmount(baseUnits: string, decimals: number): string {
  const raw = formatUnits(baseUnits, decimals);
  // formatUnits returns "0.123456789" or "1.0". Trim trailing zeros but
  // keep a sane minimum (2 dp for ≥0.01, 5 dp for <0.01).
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n === 0) return "0";
  const dp = n >= 0.01 ? Math.min(5, Math.max(2, decimals)) : 8;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  });
}

// ─── Per-row action surface ─────────────────────────────────────────────

function RowActions({
  row,
  chainId,
  handlers,
  layout,
}: {
  row: ShieldQueueEntry;
  chainId: number | null;
  handlers: RowHandlers;
  layout: "row" | "card";
}) {
  // Finalising — user already submitted a sponsor/fast-track tx. The
  // Convex query still shows the row as `queued` until the indexer
  // catches the executeShield* event (~30s); during that window we
  // replace the action buttons with a calm progress pill.
  if (handlers.finalising.has(row._id)) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full",
          "bg-[var(--priv-soft)] px-3 py-1.5",
          "text-[11.5px] font-semibold text-[var(--priv)]",
        )}
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Finalising…
      </span>
    );
  }

  // Unauthed → one CTA. Same for both table cell and card.
  if (!handlers.authed) {
    return (
      <button
        type="button"
        onClick={() =>
          toast("Sign in to contest, sponsor or fast-track shields.")
        }
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full",
          "border border-line bg-transparent px-3",
          "text-[12px] font-semibold text-ink-soft",
          "transition-colors hover:bg-paper-lo",
        )}
      >
        Sign in to take action
      </button>
    );
  }

  const roles =
    chainId !== null ? handlers.rolesByChainId.get(chainId) : undefined;
  const showContest = roles?.vigilantCitizen === true;
  const showFastTrack = roles?.boothOperator === true;
  const showSponsor = row.unlockTime * 1000 <= Date.now();

  // Authed with no role + no sponsor — nothing actionable. Show a quiet
  // hint so the row doesn't look broken.
  if (!showContest && !showFastTrack && !showSponsor) {
    return (
      <span className="text-[11px] text-ink-mute">
        No role on this chain
      </span>
    );
  }

  const buttons = (
    <>
      {showFastTrack && (
        <SmallButton
          tone="pub"
          icon={<Zap className="size-3.5" />}
          onClick={() => handlers.onFastTrack(row)}
        >
          Fast-track
        </SmallButton>
      )}
      {showSponsor && (
        <SmallButton
          tone="priv"
          icon={<Clock3 className="size-3.5" />}
          onClick={() => handlers.onSponsor(row)}
        >
          Sponsor finalise
        </SmallButton>
      )}
      {showContest && (
        <SmallButton
          tone="pub"
          icon={<ShieldAlert className="size-3.5" />}
          onClick={() => handlers.onContest(row)}
        >
          Contest
        </SmallButton>
      )}
    </>
  );

  if (layout === "row") {
    return (
      <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
        {buttons}
      </div>
    );
  }
  return <div className="flex flex-wrap gap-1.5">{buttons}</div>;
}

function SmallButton({
  tone,
  icon,
  onClick,
  children,
}: {
  tone: "pub" | "priv";
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-3",
        "text-[12px] font-semibold transition-colors",
        tone === "priv"
          ? [
              "bg-[var(--priv-soft)] text-[var(--priv)]",
              "hover:bg-[var(--priv-soft-2)]",
            ]
          : [
              "bg-[var(--pub-soft)] text-[var(--pub)]",
              "hover:bg-[var(--pub-soft-2)]",
            ],
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Formatting helpers ─────────────────────────────────────────────────

function shortAddress(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function unlockLabel(unixSeconds: number): string {
  const targetMs = unixSeconds * 1000;
  const delta = targetMs - Date.now();
  if (delta <= 0) {
    const elapsed = Math.round(-delta / 1000);
    if (elapsed < 60) return `ready · ${elapsed}s past`;
    const minutes = Math.round(elapsed / 60);
    return `ready · ${minutes}m past`;
  }
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

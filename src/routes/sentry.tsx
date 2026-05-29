import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import {
  Clock3,
  Eye,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  Wrench,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { AccountAvatar } from "@/components/pampalo/AccountAvatar";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { BrandLockup } from "@/components/pampalo/BrandLockup";
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
import {
  useDeploymentRoles,
  type DeploymentRoles,
} from "@/lib/use-deployment-roles";
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
  const [filter, setFilter] = useState<NetworkFilter>("all");

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
            className="hidden sm:inline-flex"
          />
          <NetworkFilterTabs
            value={filter}
            options={filterOptions}
            onChange={setFilter}
            appearance="badges"
            className="sm:hidden"
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
  onContest: (row: ShieldQueueEntry) => void;
  onSponsor: (row: ShieldQueueEntry) => void;
  onFastTrack: (row: ShieldQueueEntry) => void;
};

function QueueBody({
  isDesktop,
  status,
  results,
  deployments,
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
} & Omit<RowHandlers, "rolesByChainId"> & {
    rolesByChainId: Map<number, DeploymentRoles>;
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
    onContest,
    onSponsor,
    onFastTrack,
  };
  if (isDesktop) {
    return (
      <QueueTable
        results={results}
        deployments={deployments}
        handlers={handlers}
      />
    );
  }
  return (
    <QueueCards
      results={results}
      deployments={deployments}
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
  handlers,
}: {
  results: ShieldQueueEntry[];
  deployments: Deployment[];
  handlers: RowHandlers;
}) {
  const deploymentChainById = useMemo(() => {
    const m = new Map<string, Deployment>();
    for (const d of deployments) m.set(d._id, d);
    return m;
  }, [deployments]);

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
            return (
              <TableRow key={row._id} className="border-line">
                <TableCell className="font-mono text-[12px] text-ink">
                  {dep?.networkName ?? `chain ${row.deploymentId}`}
                </TableCell>
                <TableCell className="font-mono text-[12px] text-ink">
                  {shortAddress(row.shielder)}
                </TableCell>
                <TableCell className="font-mono text-[12px] text-ink">
                  {row.amount} ({shortAddress(row.asset)})
                </TableCell>
                <TableCell className="font-mono text-[12px] text-ink-soft">
                  {timeAgo(row.queuedAt)}
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
  handlers,
}: {
  results: ShieldQueueEntry[];
  deployments: Deployment[];
  handlers: RowHandlers;
}) {
  const deploymentChainById = useMemo(() => {
    const m = new Map<string, Deployment>();
    for (const d of deployments) m.set(d._id, d);
    return m;
  }, [deployments]);

  return (
    <ul className="flex flex-col gap-3">
      {results.map((row) => {
        const dep = deploymentChainById.get(row.deploymentId);
        return (
          <li key={row._id}>
            <div className="rounded-2xl card-cream p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute">
                    {dep?.networkName ?? `chain ?`}
                  </div>
                  <div className="mt-1 font-mono text-[13px] text-ink">
                    {shortAddress(row.shielder)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[13px] font-semibold text-ink">
                    {row.amount}
                  </div>
                  <div className="font-mono text-[11px] text-ink-mute">
                    {shortAddress(row.asset)}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11.5px] text-ink-mute">
                <span>Queued {timeAgo(row.queuedAt)}</span>
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRpcClient } from "@/lib/rpc";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { Loader2, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { AccountAvatar } from "@/components/pampalo/AccountAvatar";
import { AssetRow, type AssetRowData } from "@/components/pampalo/AssetRow";
import type { CancelRequest } from "@/components/pampalo/PendingShieldsList";
import {
  CancelShieldSheet,
  type CancelShieldPayload,
} from "@/components/pampalo/shield/CancelShieldSheet";
import { warmShield } from "@/lib/shield-prep";
import {
  usePrivateBalances,
  type AssetBucket,
  type PendingNote,
} from "@/lib/use-private-balances";
import {
  ActionConfirmSheet,
  type ActionConfirmPayload,
} from "@/components/pampalo/sentry/ActionConfirmSheet";
import { useShieldBudget } from "@/lib/use-shield-budget";
import { useShieldQueueSync } from "@/lib/use-shield-queue-sync";
import {
  backfillLeafIndices,
  syncShieldNotesExplicit,
} from "@/lib/sync-shield-notes";
import {
  ShieldConfirmSheet,
  type ShieldConfirmPayload,
} from "@/components/pampalo/shield/ShieldConfirmSheet";
import {
  UnshieldConfirmSheet,
  type UnshieldConfirmPayload,
} from "@/components/pampalo/shield/UnshieldConfirmSheet";
import { BalanceCard } from "@/components/pampalo/BalanceCard";
import { PreviousDeploymentBanner } from "@/components/pampalo/PreviousDeploymentBanner";
import { DepositSheet } from "@/components/pampalo/deposit/DepositSheet";
import { ReceiveSheet } from "@/components/pampalo/receive/ReceiveSheet";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { BrandLockup } from "@/components/pampalo/BrandLockup";
import {
  NetworkFilterTabs,
  type NetworkFilter,
} from "@/components/pampalo/NetworkFilterTabs";
import { PageLayout } from "@/components/pampalo/PageLayout";
import { PageLoading } from "@/components/pampalo/PageLoading";
import { SendSheet } from "@/components/pampalo/send/SendSheet";
import { SwapModal } from "@/components/pampalo/SwapModal";
import { ThemeToggle } from "@/components/pampalo/ThemeToggle";
import { useAccountModal } from "@/lib/account-modal";
import {
  usePrivateBalance,
  usePublicBalance,
  weiToNumber,
} from "@/lib/balances";
import { useAuth } from "@/lib/auth";
import { getBlob } from "@/lib/keystore";
import { isTestnetChainId, useTestnetsEnabled } from "@/lib/preferences";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/wallet")({ component: Wallet });

function Wallet() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const accountModal = useAccountModal();
  const [reauthing, setReauthing] = useState(false);

  useEffect(() => {
    if (auth.state.status === "anonymous") {
      void navigate({ to: "/" });
    }
  }, [auth.state.status, navigate]);

  if (auth.state.status !== "authenticated") {
    return <PageLoading />;
  }

  const addresses = auth.state.addresses;

  async function onReAuth() {
    setReauthing(true);
    try {
      await auth.reAuth();
      toast("Wallet unlocked");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn’t unlock wallet.";
      toast.error(msg);
    } finally {
      setReauthing(false);
    }
  }

  return (
    <PageLayout>
      {/* Full-width beach band — same vibe as the landing page. Header
          floats over it with absolute positioning so it lines up with
          the dashboard column below. */}
      <div className="relative shrink-0 w-full">
        <BeachScene height={280} theme={theme} />
        <div className="absolute inset-x-0 top-6 z-10 pointer-events-none">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 lg:max-w-4xl">
            <Link
              to="/"
              aria-label="Pampalo home"
              className="pointer-events-auto flex items-center gap-2 rounded-md transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink/15"
            >
              <BrandLockup />
            </Link>
            <div className="pointer-events-auto flex items-center gap-2">
              <ThemeToggle />
              {addresses && (
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
                  <AccountAvatar address={addresses.evm} size={32} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Dashboard column. Pulled up with -mt-10 so the first card overlaps
          the beach's bottom edge, matching the landing's hero card. */}
      <div className="relative z-10 -mt-10 mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-[8vw] pb-12 sm:px-4 lg:max-w-4xl">
        {addresses ? (
          <Dashboard addresses={addresses} />
        ) : (
          <section className="rise-in rounded-3xl card-cream px-5 py-5">
            <NoAddressNotice
              onUnlock={onReAuth}
              loading={reauthing}
              canReAuth={getBlob() !== null}
            />
          </section>
        )}
      </div>
    </PageLayout>
  );
}

// ─── Dashboard ──────────────────────────────────────────────────────────

type Token = {
  _id: string;
  chainId: number;
  networkName: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
  roundTo?: number;
  priceFeedShortId?: string;
};

type PriceRow = {
  shortId: string;
  answer: string;
  feedDecimals: number;
};

/** USD per whole unit of the token, or null if the feed hasn't loaded. */
function usdPriceFor(
  token: Token,
  prices: PriceRow[] | undefined,
): number | null {
  if (!token.priceFeedShortId) {
    // Stables (USDC) — treated as $1. Real stable depeg detection would
    // live elsewhere; for the dashboard, $1 is the right default.
    return 1;
  }
  if (!prices) return null;
  const feed = prices.find((p) => p.shortId === token.priceFeedShortId);
  if (!feed) return null;
  // All catalogue feeds are quoted as base/usd, so the rate is USD per
  // base (e.g. "eth/usd" = USD per ETH, "aud/usd" = USD per AUD ≈ USD
  // per AUDD).
  return Number(feed.answer) / 10 ** feed.feedDecimals;
}

function Dashboard({
  addresses,
}: {
  addresses: { evm: string; envelope: string; poseidon: string };
}) {
  const evmAddress = addresses.evm;
  const tokensRaw = useQuery(api.catalog.tokens.list, {});
  const prices = useQuery(api.prices.feeds.listLatest, {});
  const networksRaw = useQuery(api.catalog.networks.list, {});
  // (chainId, lowercased tokenAddress) pairs the Pampalo contract suite
  // is currently registered to handle. Used to gate the shield/unshield
  // slider per row — if the pair isn't here, the row shows a static
  // SplitBar instead of a draggable handle.
  //
  // Forced empty when the network filter is "all": multi-chain rows
  // can't decide which deployment to shield through, so we only expose
  // the slider once the user has picked a specific network.
  const shieldablePairsRaw = useQuery(
    api.shieldQueue.store.shieldablePairs,
    {},
  );
  const [testnetsEnabled] = useTestnetsEnabled();

  const [filter, setFilter] = useState<NetworkFilter>("all");

  const shieldableKeys = useMemo(() => {
    const s = new Set<string>();
    if (filter === "all") return s;
    for (const p of shieldablePairsRaw ?? []) {
      s.add(`${p.chainId}:${p.tokenAddress.toLowerCase()}`);
    }
    return s;
  }, [shieldablePairsRaw, filter]);

  const [shieldPayload, setShieldPayload] =
    useState<ShieldConfirmPayload | null>(null);
  const [unshieldPayload, setUnshieldPayload] =
    useState<UnshieldConfirmPayload | null>(null);
  const [cancelPayload, setCancelPayload] =
    useState<CancelShieldPayload | null>(null);
  const [finalisePayload, setFinalisePayload] =
    useState<ActionConfirmPayload | null>(null);
  // Lowercased leafCommitments whose executeShield was just broadcast — the
  // row shows a "Finalising…" pill until the indexer drops it or a timeout.
  const [finalising, setFinalising] = useState<Set<string>>(new Set());
  const refreshIndexer = useAction(api.shieldQueue.refresh.refreshShieldQueueNow);

  // Resolve a queued pending shield's on-chain pendingId (from the user's
  // shield-queue rows) + its deployment router, then open the cancel sheet.
  const myShields = useQuery(
    api.shieldQueue.store.byShielder,
    addresses.evm ? { shielder: addresses.evm } : "skip",
  );
  const deploymentRows = useQuery(
    api.shieldQueue.store.enabledDeployments,
    {},
  );
  const pendingIdByLeaf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of myShields ?? []) {
      if (r.state === "queued") m.set(r.leafCommitment.toLowerCase(), r.pendingId);
    }
    return m;
  }, [myShields]);
  const handleCancelPending = (req: CancelRequest) => {
    const pendingId = pendingIdByLeaf.get(req.leafCommitment.toLowerCase());
    const dep = deploymentRows?.find((d) => d.chainId === req.chainId);
    if (!pendingId || !dep) {
      toast.error("Couldn't resolve this shield yet — tap Sync and try again.");
      return;
    }
    setCancelPayload({
      pendingId,
      chainId: req.chainId,
      pampaloAddress: dep.pampaloAddress,
      amount: req.amount,
      symbol: req.symbol,
      decimals: req.decimals,
      leafCommitment: req.leafCommitment,
      priceUsd: req.priceUsd ?? null,
    });
  };

  // Finalise a ready (unlock-elapsed) pending shield of the user's own —
  // the same `executeShield(id)` the sentry "Sponsor finalise" runs, just
  // initiated by the shielder. Look up the full queue row (we already hold
  // the user's `byShielder` rows) and hand it to the shared confirm sheet.
  const handleFinalisePending = (note: PendingNote) => {
    const row = myShields?.find(
      (r) =>
        r.leafCommitment.toLowerCase() === note.leafCommitment.toLowerCase(),
    );
    if (!row) {
      toast.error("Couldn't resolve this shield yet — tap Sync and try again.");
      return;
    }
    setFinalisePayload({ kind: "sponsor", row });
  };

  // After executeShield is broadcast, optimistically mark the leaf
  // "finalising" so its row swaps the buttons for a progress pill. Cleared
  // two ways: (a) server confirmation — the useEffect below drops it once
  // the indexer flips the queue row out of `queued`; (b) a 90s safety
  // timeout, so a reverted / never-indexed finalise falls back to buttons.
  const markFinalising = (leafCommitment: string) => {
    const key = leafCommitment.toLowerCase();
    setFinalising((prev) => new Set(prev).add(key));
    // Nudge the indexer so executeShield lands sooner than the ~30s cron.
    void refreshIndexer({}).catch(() => undefined);
    window.setTimeout(() => {
      setFinalising((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 90_000);
  };
  // Server confirmation: `pendingIdByLeaf` only holds still-`queued` shields,
  // so when a finalising leaf leaves it, the indexer has confirmed the
  // finalise — clear the pill.
  useEffect(() => {
    setFinalising((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const leaf of prev) {
        if (!pendingIdByLeaf.has(leaf)) {
          next.delete(leaf);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [pendingIdByLeaf]);

  // Per-(chain, asset) "tx confirming on-chain" set. While a row is
  // in here, AssetRow disables its slider + action buttons and shows
  // a "Confirming…" banner. Cleared when receipt polling confirms the
  // tx (or after a hard 90s safety timeout — Base Sepolia blocks land
  // in seconds, so anything still pending past that is anomalous).
  type PendingMoveKey = string; // `${chainId}:${assetAddressLower}`
  type PendingMove = {
    kind: "shield" | "unshield";
    txHash: string;
    startedAt: number;
  };
  const [pendingMoves, setPendingMoves] = useState<
    ReadonlyMap<PendingMoveKey, PendingMove>
  >(new Map());
  const pendingMoveKey = (chainId: number, asset: string): PendingMoveKey =>
    `${chainId}:${asset.toLowerCase()}`;
  const registerPendingMove = (
    kind: "shield" | "unshield",
    chainId: number,
    assetAddress: string,
    txHash: string,
  ) => {
    setPendingMoves((prev) => {
      const next = new Map(prev);
      next.set(pendingMoveKey(chainId, assetAddress), {
        kind,
        txHash,
        startedAt: Date.now(),
      });
      return next;
    });
  };

  // Receipt polling for every pending move. Each entry gets one
  // setInterval; we clear it either on confirmation or on the 90s
  // safety timeout. The rpc client comes from the same provider the
  // confirm sheets use, so the polls reuse Alchemy connection state.
  const rpcClient = useRpcClient();
  const queryClient = useQueryClient();
  // The moment a move is mined, force the public-balance query for that
  // (chain, asset) to refetch. Without this the row unlocks (pendingMoves
  // cleared) but `usePublicBalance` keeps showing the pre-move balance
  // until its 30s `refetchInterval` fires — so the slider snaps back to
  // the OLD split and the idle hint reappears, reading as "nothing
  // happened". The private side already updates optimistically via IDB;
  // this closes the gap on the public side. A short delayed re-invalidate
  // absorbs Alchemy replica lag (the receipt can land a beat before the
  // balance endpoint reflects it).
  const refreshPublicBalance = useCallback(
    (cId: number, assetLower: string) => {
      const queryKey = ["public-balance", cId, assetLower];
      void queryClient.invalidateQueries({ queryKey });
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey });
      }, 2_500);
    },
    [queryClient],
  );
  useEffect(() => {
    if (pendingMoves.size === 0) return;
    const intervals: number[] = [];
    for (const [key, move] of pendingMoves) {
      const [chainStr, assetLower] = key.split(":");
      const cId = Number(chainStr);
      const tick = async () => {
        if (Date.now() - move.startedAt > 90_000) {
          setPendingMoves((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
          // Anomalous: the tx never confirmed in 90s. Refresh anyway so a
          // late-landing tx isn't stuck behind the 30s interval.
          refreshPublicBalance(cId, assetLower);
          return;
        }
        try {
          const res = await rpcClient.getTransactionStatus(cId, move.txHash);
          if (res.status === true || res.status === false) {
            setPendingMoves((prev) => {
              const next = new Map(prev);
              next.delete(key);
              return next;
            });
            refreshPublicBalance(cId, assetLower);
          }
        } catch {
          // transient — keep polling
        }
      };
      // 1.5s poll — Base Sepolia blocks land in ~2s, so the average
      // detection latency drops from ~1.5s (3s/2) to ~0.75s (1.5s/2).
      // Cheap on the RPC side (single eth_getTransactionReceipt per
      // tick) and visibly shortens the "Confirming on-chain" window.
      const handle = window.setInterval(() => void tick(), 1_500);
      intervals.push(handle);
      void tick();
    }
    return () => {
      for (const h of intervals) window.clearInterval(h);
    };
  }, [pendingMoves, rpcClient, refreshPublicBalance]);

  // IDB-derived private balances + pending shields. The hook
  // re-subscribes via useSyncExternalStore so any optimistic write or
  // Convex reconcile path that touches `idb-notes.ts` propagates here
  // automatically.
  const privateBalances = usePrivateBalances(evmAddress);

  // Same-device Convex → IDB writer. Reactively patches IDB notes
  // forward (queued → spendable/cancelled/contested) whenever the
  // server-side indexer flips a row's state. Cross-device hydration
  // (decrypt + insert from a foreign device's optimistic write) is
  // deferred. See SHIELD_FLOW.md §3.4.
  useShieldQueueSync(evmAddress);

  // Lightweight leaf-index backfill on every wallet mount. No PRF
  // needed — it's pure IDB ↔ pampaloLeaves reconciliation. Without
  // this, a freshly-spendable note can't be spent in a transfer
  // until the user remembers to tap Sync (the shield-side writer
  // only patches state + unlockTime + queuedTxHash; leafIndex lives
  // in pampaloLeaves). Runs once per mount.
  useEffect(() => {
    void backfillLeafIndices().catch((e) => {
      console.warn("[wallet] leaf-index backfill failed", e);
    });
  }, [evmAddress]);

  // Pre-warm the bb.js + deposit circuit bundle on idle. First-shield
  // latency is dominated by WASM warmup; doing it speculatively after
  // the page is interactive moves that cost out of the user's tap path.
  // No-op on subsequent mounts because the warm cache is module-scoped.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const fire = () => {
      void warmShield().catch(() => {
        // Swallow — the user-initiated path retries through the same
        // cached promise and surfaces real errors there.
      });
    };
    const rIC = w.requestIdleCallback;
    const cIC = w.cancelIdleCallback;
    if (typeof rIC === "function" && typeof cIC === "function") {
      const handle = rIC(fire, { timeout: 4000 });
      return () => {
        cIC(handle);
      };
    }
    // Safari fallback (no rIC). Defer until after first paint.
    const t = setTimeout(fire, 1500);
    return () => clearTimeout(t);
  }, []);

  // Hide testnet chains + tokens unless the user opted in via the
  // session-scoped preference in the account modal.
  const networks = useMemo(
    () =>
      networksRaw?.filter(
        (n) => testnetsEnabled || !isTestnetChainId(n.chainId),
      ),
    [networksRaw, testnetsEnabled],
  );
  const tokens = useMemo(
    () =>
      tokensRaw?.filter((t) => testnetsEnabled || !isTestnetChainId(t.chainId)),
    [tokensRaw, testnetsEnabled],
  );

  // If the user had a testnet selected then disabled them, fall back to
  // "all" so the filter doesn't point at a now-hidden chain.
  useEffect(() => {
    if (filter !== "all" && !testnetsEnabled && isTestnetChainId(filter)) {
      setFilter("all");
    }
  }, [filter, testnetsEnabled]);

  const filterOptions = useMemo(() => {
    const base: { value: NetworkFilter; label: string }[] = [
      { value: "all", label: "All" },
    ];
    if (!networks) return base;
    return base.concat(
      networks.map((n) => ({ value: n.chainId, label: n.name })),
    );
  }, [networks]);

  // Group tokens by symbol so ETH-on-mainnet + ETH-on-base render as one
  // row with both chain chips. The filter narrows which chainIds are
  // included in each group.
  const groupedAssets = useMemo(() => {
    if (!tokens) return null;
    const visible = tokens.filter((t) => {
      if (filter === "all") return true;
      return t.chainId === filter;
    });
    // WETH folds into the ETH row (ADR 0024): on the pre-wrap contract a
    // shielded "ETH" is held as WETH, so we display native ETH + WETH as one
    // ETH balance. The group key maps WETH → ETH; the row aggregates both.
    const groupKeyFor = (t: Token) => (t.symbol === "WETH" ? "ETH" : t.symbol);
    const bySymbol = new Map<string, Token[]>();
    for (const t of visible) {
      const key = groupKeyFor(t);
      const arr = bySymbol.get(key) ?? [];
      arr.push(t);
      bySymbol.set(key, arr);
    }
    return Array.from(bySymbol.entries()).map(([symbol, toks]) => ({
      symbol,
      // Native ETH first so the row's symbol/decimals/price come from ETH,
      // not the folded-in WETH.
      tokens: [...toks].sort((a, b) =>
        a.symbol === b.symbol ? 0 : a.symbol === "ETH" ? -1 : 1,
      ),
    }));
  }, [tokens, filter]);

  return (
    <>
      <PreviousDeploymentBanner evmAddress={evmAddress} />

      <BalanceCardConnected
        tokens={tokens ?? null}
        prices={prices ?? null}
        evmAddress={evmAddress}
        envelope={addresses.envelope}
        poseidon={addresses.poseidon}
      />

      <section className="rounded-3xl card-cream px-5 pt-4 pb-5">
        {/* Mobile (< sm): stacked — title + description take the full
            width, network filter sits below as badges so it doesn't
            squeeze the description into a narrow side column. Desktop
            keeps the segmented tab control next to the title. */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-[20px] font-bold text-ink">
              Your assets
            </h2>
            <p className="text-[12px] text-ink-mute">
              Each balance is split between what’s visible on-chain and what’s
              shielded.
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
        </div>

        {groupedAssets === null ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="skel"
                style={{ height: 132, width: "100%", borderRadius: 22 }}
              />
            ))}
          </div>
        ) : groupedAssets.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-mute">
            No assets on this network yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {groupedAssets.map((g) => {
              // The key includes the chain set because AssetGroupRow calls
              // balance hooks inside a tokens.map() — if the filter shrinks
              // an ETH group from [mainnet, base] to [mainnet] without a
              // remount, React sees fewer hooks on the next render and
              // throws "Rendered fewer hooks than expected." Including
              // chainIds in the key forces a remount whenever that shape
              // changes; React Query keeps the underlying balances cached
              // so there's no visible refetch.
              const groupKey = `${g.symbol}:${g.tokens
                .map((t) => t.chainId)
                .join(",")}`;
              return (
                <li key={groupKey}>
                  <AssetGroupRow
                    symbol={g.symbol}
                    tokens={g.tokens}
                    prices={prices ?? undefined}
                    evmAddress={evmAddress}
                    shieldableKeys={shieldableKeys}
                    onShield={setShieldPayload}
                    onUnshield={setUnshieldPayload}
                    onCancelPending={handleCancelPending}
                    onFinalisePending={handleFinalisePending}
                    finalising={finalising}
                    privateBuckets={privateBalances.perAsset}
                    pendingMoves={pendingMoves}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ShieldConfirmSheet
        open={shieldPayload !== null}
        onOpenChange={(next) => {
          if (!next) setShieldPayload(null);
        }}
        payload={shieldPayload}
        addresses={addresses}
        onBroadcasted={(p) =>
          registerPendingMove("shield", p.chainId, p.assetAddress, p.txHash)
        }
      />
      <UnshieldConfirmSheet
        open={unshieldPayload !== null}
        onOpenChange={(next) => {
          if (!next) setUnshieldPayload(null);
        }}
        payload={unshieldPayload}
        addresses={addresses}
        onBroadcasted={(p) =>
          registerPendingMove("unshield", p.chainId, p.assetAddress, p.txHash)
        }
      />
      <CancelShieldSheet
        open={cancelPayload !== null}
        onOpenChange={(next) => {
          if (!next) setCancelPayload(null);
        }}
        payload={cancelPayload}
        evmAddress={addresses.evm}
      />
      <ActionConfirmSheet
        open={finalisePayload !== null}
        onOpenChange={(next) => {
          if (!next) setFinalisePayload(null);
        }}
        payload={finalisePayload}
        evmAddress={addresses.evm}
        deployments={deploymentRows ?? []}
        onSubmitted={() => {
          if (finalisePayload) markFinalising(finalisePayload.row.leafCommitment);
        }}
      />
    </>
  );
}

// ─── BalanceCard ─────────────────────────────────────────────────────────
// Hosts the public+private aggregation. Sums every token's individual
// balance hook through `AssetGroupRow`'s contract — the per-row hooks
// publish into a shared map via a tiny pubsub. To keep the wiring boring,
// we just rerun the same hooks here against the first (primary) network
// for each symbol; the dashboard then trusts the AssetRow components for
// per-chain detail. Sums use the same maths the rows do.

function BalanceCardConnected({
  tokens,
  prices,
  evmAddress,
  envelope,
  poseidon,
}: {
  tokens: Token[] | null;
  prices: PriceRow[] | null;
  evmAddress: string;
  envelope: string;
  poseidon: string;
}) {
  const [swapOpen, setSwapOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Staleness nudge — the Sync chip shimmers warmly and a hint line
  // appears between the action row and the balance chips while
  // `staleSync` is true. Starts FALSE on mount so a fresh login/signup
  // isn't immediately nagged — the effect below arms the STALE_TTL_MS
  // timer, so the first nudge appears 2 minutes in. A successful sync
  // flips it off and re-arms the timer, so the user gets a fresh nudge
  // if they hang out on the dashboard.
  const STALE_TTL_MS = 120_000;
  const [staleSync, setStaleSync] = useState(false);
  const onSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncShieldNotesExplicit();
      const total =
        result.added + result.skippedAlreadyPresent + result.skippedByCursor;
      if (result.added > 0) {
        toast(`Synced ${result.added} note${result.added === 1 ? "" : "s"}.`);
      } else if (total === 0) {
        toast("Nothing to sync.");
      } else {
        toast("Already up to date.");
      }
      setStaleSync(false);
    } catch (e) {
      console.warn("[sync] failed", e);
      toast.error("Sync failed - try again.");
    } finally {
      setSyncing(false);
    }
  };
  useEffect(() => {
    if (staleSync) return;
    const t = setTimeout(() => setStaleSync(true), STALE_TTL_MS);
    return () => clearTimeout(t);
  }, [staleSync]);
  if (!tokens) {
    return (
      <BalanceCard totalUsd={null} publicUsd={null} privateUsd={null} loading />
    );
  }
  // Same hook-count protection as AssetGroupRow below: BalanceCardWithBalances
  // calls usePublicBalance/usePrivateBalance inside tokens.map(), so when the
  // testnets toggle adds/removes Sepolia rows mid-session the hook count
  // would change between renders ("Rendered more hooks than during the
  // previous render"). Keying on the token-set signature forces a remount
  // whenever that shape changes; react-query keeps the balance cache so
  // there's no visible refetch.
  const balanceKey = tokens
    .map((t) => `${t.chainId}:${t.address.toLowerCase()}`)
    .join("|");
  return (
    <>
      <BalanceCardWithBalances
        key={balanceKey}
        tokens={tokens}
        prices={prices}
        evmAddress={evmAddress}
        onSwap={() => setSwapOpen(true)}
        onSend={() => setSendOpen(true)}
        onSync={onSync}
        syncing={syncing}
        staleSync={staleSync}
        onReceive={() => setReceiveOpen(true)}
        onDeposit={() => setDepositOpen(true)}
      />
      <SwapModal
        open={swapOpen}
        onOpenChange={setSwapOpen}
        evmAddress={evmAddress}
        envelope={envelope}
        poseidon={poseidon}
      />
      <SendSheet
        open={sendOpen}
        onOpenChange={setSendOpen}
        evmAddress={evmAddress}
        selfPoseidon={poseidon}
        selfEnvelopePubKey={envelope}
      />
      <DepositSheet
        open={depositOpen}
        onOpenChange={setDepositOpen}
        address={evmAddress}
        envelope={envelope}
        poseidon={poseidon}
      />
      <ReceiveSheet open={receiveOpen} onOpenChange={setReceiveOpen} />
    </>
  );
}

function BalanceCardWithBalances({
  tokens,
  prices,
  evmAddress,
  onSwap,
  onSend,
  onSync,
  syncing,
  staleSync,
  onReceive,
  onDeposit,
}: {
  tokens: Token[];
  prices: PriceRow[] | null;
  evmAddress: string;
  onSwap?: () => void;
  onSend?: () => void;
  onSync?: () => void;
  syncing?: boolean;
  staleSync?: boolean;
  onReceive?: () => void;
  onDeposit?: () => void;
}) {
  // IDB-backed private balances — same hook the per-asset rows use to
  // render "0.01377 ETH" under PRIVATE. The per-token `usePrivateBalance`
  // stub below still returns 0, so we no longer sum from it; instead
  // we fold the per-asset spendable buckets into the dashboard total
  // here. Without this, the top card shows "Private $0" even when the
  // user demonstrably has shielded notes (the visible bug in the
  // screenshot).
  const privateBuckets = usePrivateBalances(evmAddress).perAsset;
  // Read the preference directly (rather than inferring from whether
  // testnet tokens survived the upstream filter) so "testnets off"
  // reliably hides the secondary headline even if the catalog has no
  // testnet entries yet.
  const [testnetsEnabled] = useTestnetsEnabled();
  // Aggregate by symbol — one balance lookup per (chainId, address).
  // React allows this because the token list is stable across renders;
  // we map deterministically so hook order doesn't change.
  const rows = tokens.map((t) => {
    const pub = usePublicBalance(
      {
        chainId: t.chainId,
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
      },
      evmAddress,
    );
    const priv = usePrivateBalance(
      {
        chainId: t.chainId,
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
      },
      evmAddress,
    );
    return { token: t, pub, priv };
  });

  // Mainnet and testnet sums accumulate into separate buckets so the
  // headline only ever shows real money — testnet holdings (valued with
  // the same mainnet price feeds, so the number is meaningful) roll up
  // into a single combined public+private figure rendered as the
  // "$X.XX Testnet" secondary headline. Loading flags are tracked per
  // bucket: a slow Sepolia RPC or missing testnet feed must never hold
  // the mainnet headline at skeleton, and vice versa.
  // No private-side loading flag: the legacy per-token private hook is
  // a stub (always 0) and the IDB buckets folded in below are
  // synchronously available, so only public balances + price feeds can
  // hold a bucket at skeleton.
  let publicUsd = 0; // mainnet only
  let privateUsd = 0; // mainnet only
  let testnetUsd = 0; // testnet, public + private combined
  let anyPubLoading = false;
  let anyPriceMissing = false;
  let anyTestnetLoading = false;

  for (const r of rows) {
    const isTestnet = isTestnetChainId(r.token.chainId);
    const price = usdPriceFor(r.token, prices ?? undefined);
    if (price === null) {
      if (isTestnet) anyTestnetLoading = true;
      else anyPriceMissing = true;
    }

    if (r.pub.data) {
      const amt = weiToNumber(r.pub.data.balanceWei, r.token.decimals);
      if (price !== null) {
        if (isTestnet) testnetUsd += amt * price;
        else publicUsd += amt * price;
      }
    } else if (r.pub.isLoading) {
      if (isTestnet) anyTestnetLoading = true;
      else anyPubLoading = true;
    } else if (r.pub.error) {
      // Don't block totals on a single failing chain — log and treat
      // as 0 for now so the rest of the dashboard still renders.
      console.warn(
        `Public balance failed (${r.token.symbol} on chain ${r.token.chainId}):`,
        r.pub.error,
      );
    }

    // r.priv (the legacy per-token hook) is a placeholder that always
    // returns 0 — see SHIELD_FLOW.md notes downstream. The real
    // private balance comes from the IDB-backed buckets folded in
    // after this loop.
  }

  // Fold IDB-backed spendable balances into privateUsd by matching
  // each bucket to its catalog token (for the price feed). Buckets
  // for chains/assets not in the current catalog are silently
  // ignored — same posture as a public balance for a token that
  // dropped out of the catalogue.
  for (const b of privateBuckets) {
    const token = tokens.find(
      (t) => t.chainId === b.chainId && t.address.toLowerCase() === b.asset,
    );
    if (!token) continue;
    const price = usdPriceFor(token, prices ?? undefined);
    if (price === null) continue;
    const amt = weiToNumber(b.spendable, token.decimals);
    if (isTestnetChainId(b.chainId)) testnetUsd += amt * price;
    else privateUsd += amt * price;
  }

  const mainLoading = anyPubLoading || anyPriceMissing;
  return (
    <BalanceCard
      totalUsd={mainLoading ? null : publicUsd + privateUsd}
      publicUsd={mainLoading ? null : publicUsd}
      privateUsd={mainLoading ? null : privateUsd}
      // undefined hides the line entirely (testnets off); null renders
      // its skeleton while testnet rows/feeds are still resolving.
      testnetUsd={
        !testnetsEnabled ? undefined : anyTestnetLoading ? null : testnetUsd
      }
      onSwap={onSwap}
      onSend={onSend}
      onSync={onSync}
      syncing={syncing}
      staleSync={staleSync}
      onReceive={onReceive}
      onDeposit={onDeposit}
    />
  );
}

// ─── AssetGroupRow ──────────────────────────────────────────────────────
// Renders one logical asset (e.g. "ETH") that may exist on multiple
// chains. Sums balances across chains, shows all chain chips. Each chain
// gets its own balance hook so refresh + loading state stays accurate
// per network.

function AssetGroupRow({
  tokens,
  prices,
  evmAddress,
  shieldableKeys,
  onShield,
  onUnshield,
  onCancelPending,
  onFinalisePending,
  finalising,
  privateBuckets,
  pendingMoves,
}: {
  symbol: string;
  tokens: Token[];
  prices: PriceRow[] | undefined;
  evmAddress: string;
  shieldableKeys: Set<string>;
  onShield: (payload: ShieldConfirmPayload) => void;
  onUnshield: (payload: UnshieldConfirmPayload) => void;
  onCancelPending: (req: CancelRequest) => void;
  onFinalisePending: (note: PendingNote) => void;
  finalising: Set<string>;
  privateBuckets: AssetBucket[];
  /** Wallet-level "tx confirming on-chain" set, keyed by
   *  `${chainId}:${assetAddress.toLowerCase()}`. */
  pendingMoves: ReadonlyMap<string, { kind: "shield" | "unshield" }>;
}) {
  // Same deterministic-render assumption as the BalanceCard: token list
  // is stable so hook order is stable.
  const chainStates = tokens.map((t) => {
    const pub = usePublicBalance(
      {
        chainId: t.chainId,
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
      },
      evmAddress,
    );
    const priv = usePrivateBalance(
      {
        chainId: t.chainId,
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
      },
      evmAddress,
    );
    return { token: t, pub, priv };
  });

  // Combine into a single AssetRow input. Sum is in token units (all the
  // grouped rows share decimals + symbol so the addition is safe). A
  // chain that errored is treated as 0 so a single failing chain doesn't
  // hide the others — the warning surfaces via console.warn above.
  const first = tokens[0];
  const decimals = first.decimals;
  const allPubResolved = chainStates.every((c) => c.pub.data || c.pub.error);

  const sumWei = (kind: "pub" | "priv"): bigint | null => {
    let total = 0n;
    for (const c of chainStates) {
      const d = kind === "pub" ? c.pub.data : c.priv.data;
      const err = kind === "pub" ? c.pub.error : c.priv.error;
      if (!d) {
        // Treat errored chains as 0 contribution.
        if (err) continue;
        return null;
      }
      total += d.balanceWei;
    }
    return total;
  };

  const priceUsd = usdPriceFor(first, prices);

  // Pull the queued + executable notes for this asset group from the
  // shared usePrivateBalances result. We match by (chainId, token
  // address) so a multi-chain group naturally aggregates across the
  // chains it spans. spendable also flows up so the privateWei
  // display can reflect IDB rather than the placeholder stub.
  const tokenKeys = new Set(
    tokens.map((t) => `${t.chainId}:${t.address.toLowerCase()}`),
  );
  const matchingBuckets = privateBuckets.filter((b) =>
    tokenKeys.has(`${b.chainId}:${b.asset}`),
  );
  const queuedNotes = matchingBuckets.flatMap((b) => b.queuedNotes);
  const executableNotes = matchingBuckets.flatMap((b) => b.executableNotes);
  const spendableWei = matchingBuckets.reduce(
    (sum, b) => sum + b.spendable,
    0n,
  );

  // Reads of `usePrivateBalance` were a stub returning 0; the IDB
  // facade is now the source of truth. We surface `spendable` only —
  // pendingQueued + pendingExecutable get their own affordance below
  // the slider (PendingShieldsList) so they don't double-count.
  const data: AssetRowData = {
    symbol: first.symbol,
    name: first.name,
    decimals,
    roundTo: first.roundTo,
    priceUsd,
    publicWei: allPubResolved ? sumWei("pub") : null,
    privateWei: spendableWei,
    chainIds: tokens.map((t) => t.chainId),
  };

  // Folded-in WETH ERC-20 public balance, surfaced as a breakdown line under
  // the ETH row (ADR 0024). Improbable to be non-zero; AssetRow hides it at 0.
  let wrappedWei = 0n;
  let hasWrapped = false;
  for (const c of chainStates) {
    if (c.token.symbol === "WETH" && c.pub.data) {
      wrappedWei += c.pub.data.balanceWei;
      hasWrapped = true;
    }
  }
  const breakdown = hasWrapped
    ? { symbol: "WETH", wei: wrappedWei, decimals: 18 }
    : undefined;

  // Shieldable if any token in this group is in the (chainId, address)
  // set. Multi-chain rows show the slider when at least one chain is
  // supported; the active chain is still asset.chainIds[0] for v1 until
  // the per-row network-select pill (SHIELD_FLOW.md §9.1) lands.
  const shieldable = tokens.some((t) =>
    shieldableKeys.has(`${t.chainId}:${t.address.toLowerCase()}`),
  );

  // Per-user shield cap for the active chain. Drives the slider's
  // minPub clamp so the user can't drag past the cap that the on-chain
  // `_chargeShield` would revert on anyway. We use the first chain in
  // the group as the active chain (matches the AssetRow shield emit
  // logic) until the per-row network-select pill lands.
  const activeChainId = tokens[0]?.chainId ?? null;
  const budget = useShieldBudget(activeChainId, evmAddress, shieldable);

  // Convert (cap remaining in USD cents) + (price USD per whole token)
  // into a min-pub for the slider:
  //
  //   maxShieldableTokens = (remaining_cents / 100) / priceUsd * 0.99
  //                        (1% buffer absorbs Chainlink drift between
  //                         our cached price and the on-chain read at
  //                         tx time — see SHIELD_FLOW.md §9.2)
  //   minPub              = max(0, originalPub - maxShieldableTokens)
  //
  // priceUsd of 0 / unknown / null disables the clamp; the contract
  // still enforces the cap and the user will see a revert if they
  // exceed it on a non-priced asset.
  let minPub: number | undefined;
  if (budget && priceUsd && priceUsd > 0 && allPubResolved) {
    const remainingUsd = Number(budget.remainingUsdCents) / 100;
    const maxShieldable = (remainingUsd / priceUsd) * 0.99;
    const originalPub =
      sumWei("pub") !== null ? Number(sumWei("pub")!) / 10 ** decimals : 0;
    minPub = Math.max(0, originalPub - maxShieldable);
  }

  // For demo we lock the row on its active chain only — multi-chain
  // assets only have one active chain at a time.
  const confirmingMove = pendingMoves.get(
    `${activeChainId}:${tokens[0]?.address.toLowerCase() ?? ""}`,
  );

  return (
    <AssetRow
      asset={data}
      shieldable={shieldable}
      minPub={minPub}
      confirmingKind={confirmingMove?.kind ?? null}
      queuedNotes={queuedNotes}
      executableNotes={executableNotes}
      onCancel={onCancelPending}
      onFinalise={onFinalisePending}
      finalising={finalising}
      breakdown={breakdown}
      onMove={(payload) => {
        // Resolve the asset the slider actually moves. On the merged ETH row
        // the native-ETH sentinel isn't shieldable on the (pre-wrap) contract —
        // WETH is — so prefer the group's shieldable token on this chain
        // (ADR 0024). Falls back to the first on-chain token otherwise.
        // payload.chainId is always one of this group's chains, so `onChain`
        // is non-empty (it always includes `first`'s chain).
        const onChain = tokens.filter((t) => t.chainId === payload.chainId);
        const moveToken =
          onChain.find((t) =>
            shieldableKeys.has(`${t.chainId}:${t.address.toLowerCase()}`),
          ) ?? onChain[0];
        const assetAddress = moveToken.address.toLowerCase();
        if (payload.intent === "shield") {
          onShield({
            intent: "shield",
            amount: payload.amount,
            chainId: payload.chainId,
            symbol: moveToken.symbol,
            decimals: moveToken.decimals,
            assetAddress,
          });
          return;
        }
        onUnshield({
          intent: "unshield",
          amount: payload.amount,
          chainId: payload.chainId,
          symbol: moveToken.symbol,
          decimals: moveToken.decimals,
          assetAddress,
        });
      }}
    />
  );
}

// ─── Auth-shell pieces (lifted from the previous wallet.tsx) ────────────

function NoAddressNotice({
  onUnlock,
  loading,
  canReAuth,
}: {
  onUnlock: () => void;
  loading: boolean;
  canReAuth: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 text-[14px] text-ink-soft">
      <p>
        Your wallet addresses aren’t cached on this device. Unlock with your
        passkey to view your balances.
      </p>
      <button
        type="button"
        onClick={onUnlock}
        disabled={loading || !canReAuth}
        className={cn(
          "self-start inline-flex items-center gap-2 rounded-full",
          "border border-line bg-card px-3 py-2 text-[12.5px] font-semibold text-ink",
          "transition-colors hover:bg-paper-lo disabled:opacity-50",
        )}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCcw className="size-3.5" />
        )}
        Unlock with passkey
      </button>
    </div>
  );
}

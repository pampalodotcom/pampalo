import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Loader2, LogOut, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { AccountAvatar } from "@/components/pampalo/AccountAvatar";
import { AssetRow, type AssetRowData } from "@/components/pampalo/AssetRow";
import { BalanceCard } from "@/components/pampalo/BalanceCard";
import { BeachScene } from "@/components/pampalo/BeachScene";
import { BrandLockup } from "@/components/pampalo/BrandLockup";
import {
  NetworkFilterTabs,
  type NetworkFilter,
} from "@/components/pampalo/NetworkFilterTabs";
import { PageLoading } from "@/components/pampalo/PageLoading";
import { SecondaryButton } from "@/components/pampalo/SecondaryButton";
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
  const [signingOut, setSigningOut] = useState(false);
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

  async function onSignOut() {
    setSigningOut(true);
    try {
      await auth.signOut();
      toast("Signed out");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-out failed.";
      toast.error(msg);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main className="phone-shell flex min-h-dvh flex-col">
      {/* Full-width beach band — same vibe as the landing page. Header
          floats over it with absolute positioning so it lines up with
          the dashboard column below. */}
      <div className="relative shrink-0 w-full">
        <BeachScene height={280} theme={theme} />
        <div className="absolute inset-x-0 top-6 z-10 pointer-events-none">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 lg:max-w-4xl">
            <div className="pointer-events-auto flex items-center gap-2">
              <BrandLockup />
            </div>
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
      <div className="relative z-10 -mt-10 mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pb-12 lg:max-w-4xl">
        {addresses ? (
          <Dashboard evmAddress={addresses.evm} />
        ) : (
          <section className="rise-in rounded-3xl card-cream px-5 py-5">
            <NoAddressNotice
              onUnlock={onReAuth}
              loading={reauthing}
              canReAuth={getBlob() !== null}
            />
          </section>
        )}

        <div className="mt-auto">
          <SecondaryButton onClick={onSignOut} disabled={signingOut}>
            {signingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            Sign out
          </SecondaryButton>
        </div>
      </div>
    </main>
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
function usdPriceFor(token: Token, prices: PriceRow[] | undefined): number | null {
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

function Dashboard({ evmAddress }: { evmAddress: string }) {
  const tokensRaw = useQuery(api.tokens.list, {});
  const prices = useQuery(api.prices.listLatest, {});
  const networksRaw = useQuery(api.networks.list, {});
  const [testnetsEnabled] = useTestnetsEnabled();

  const [filter, setFilter] = useState<NetworkFilter>("all");

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
      tokensRaw?.filter(
        (t) => testnetsEnabled || !isTestnetChainId(t.chainId),
      ),
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
    const bySymbol = new Map<string, Token[]>();
    for (const t of visible) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    return Array.from(bySymbol.entries()).map(([symbol, toks]) => ({
      symbol,
      tokens: toks,
    }));
  }, [tokens, filter]);

  return (
    <>
      <BalanceCardConnected
        tokens={tokens ?? null}
        prices={prices ?? null}
        evmAddress={evmAddress}
      />

      <section className="rounded-3xl card-cream px-5 pt-4 pb-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-[20px] font-bold text-ink">
              Your assets
            </h2>
            <p className="text-[12px] text-ink-mute">
              Each balance is split between what’s visible on-chain and
              what’s shielded.
            </p>
          </div>
          <NetworkFilterTabs
            value={filter}
            options={filterOptions}
            onChange={setFilter}
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
            {groupedAssets.map((g) => (
              <li key={g.symbol}>
                <AssetGroupRow
                  symbol={g.symbol}
                  tokens={g.tokens}
                  prices={prices ?? undefined}
                  evmAddress={evmAddress}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
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
}: {
  tokens: Token[] | null;
  prices: PriceRow[] | null;
  evmAddress: string;
}) {
  if (!tokens) {
    return (
      <BalanceCard
        totalUsd={null}
        publicUsd={null}
        privateUsd={null}
        loading
      />
    );
  }
  return (
    <BalanceCardWithBalances
      tokens={tokens}
      prices={prices}
      evmAddress={evmAddress}
    />
  );
}

function BalanceCardWithBalances({
  tokens,
  prices,
  evmAddress,
}: {
  tokens: Token[];
  prices: PriceRow[] | null;
  evmAddress: string;
}) {
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

  let publicUsd = 0;
  let privateUsd = 0;
  let anyPubLoading = false;
  let anyPrivLoading = false;
  let anyPriceMissing = false;

  for (const r of rows) {
    const price = usdPriceFor(r.token, prices ?? undefined);
    if (price === null) anyPriceMissing = true;

    if (r.pub.data) {
      const amt = weiToNumber(r.pub.data.balanceWei, r.token.decimals);
      if (price !== null) publicUsd += amt * price;
    } else if (r.pub.isLoading) {
      anyPubLoading = true;
    } else if (r.pub.error) {
      // Don't block totals on a single failing chain — log and treat
      // as 0 for now so the rest of the dashboard still renders.
      console.warn(
        `Public balance failed (${r.token.symbol} on chain ${r.token.chainId}):`,
        r.pub.error,
      );
    }

    if (r.priv.data) {
      const amt = weiToNumber(r.priv.data.balanceWei, r.token.decimals);
      if (price !== null) privateUsd += amt * price;
    } else if (r.priv.isLoading) {
      anyPrivLoading = true;
    } else if (r.priv.error) {
      // 2 s timeout in usePrivateBalance shows up here.
      console.warn(
        `Private balance failed (${r.token.symbol} on chain ${r.token.chainId}):`,
        r.priv.error,
      );
    }
  }

  const stillLoading = anyPubLoading || anyPrivLoading || anyPriceMissing;
  return (
    <BalanceCard
      totalUsd={stillLoading ? null : publicUsd + privateUsd}
      publicUsd={stillLoading ? null : publicUsd}
      privateUsd={stillLoading ? null : privateUsd}
    />
  );
}

// ─── AssetGroupRow ──────────────────────────────────────────────────────
// Renders one logical asset (e.g. "ETH") that may exist on multiple
// chains. Sums balances across chains, shows all chain chips. Each chain
// gets its own balance hook so refresh + loading state stays accurate
// per network.

function AssetGroupRow({
  symbol,
  tokens,
  prices,
  evmAddress,
}: {
  symbol: string;
  tokens: Token[];
  prices: PriceRow[] | undefined;
  evmAddress: string;
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
  const allPrivResolved = chainStates.every((c) => c.priv.data || c.priv.error);

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

  const data: AssetRowData = {
    symbol: first.symbol,
    name: first.name,
    decimals,
    roundTo: first.roundTo,
    priceUsd,
    publicWei: allPubResolved ? sumWei("pub") : null,
    privateWei: allPrivResolved ? sumWei("priv") : null,
    chainIds: tokens.map((t) => t.chainId),
  };

  return (
    <AssetRow
      asset={data}
      onMove={() => toast(`Move ${symbol} — coming soon`)}
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

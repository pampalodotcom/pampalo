import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  usePrivateBalance,
  usePublicBalance,
  weiToNumber,
} from "@/lib/balances";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { AssetMark } from "./AssetMark";
import {
  NetworkChip,
  networkSlugForChainId,
  type NetworkSlug,
} from "./NetworkChip";
import { MoonIcon, SunIcon } from "./SunMoonIcons";

// Rich asset picker: search + filter pills + sectioned rows. Replaces
// the bare <select> in the Swap modal. Designed per the AssetSelect
// spec the user provided. Self-contained — owns search/filter state.

export type TokenPair = {
  symbol: string;
  name: string;
  chainId: number;
  address: string;
  decimals: number;
  priceFeedShortId?: string;
};

type PriceRow = {
  shortId: string;
  answer: string;
  feedDecimals: number;
};

type Filter = "all" | "mine" | NetworkSlug;

// USD per whole unit; mirrors the helper in SwapModal/Wallet — defaults
// USDC (no feed) to $1.
function usdPriceFor(
  token: TokenPair,
  prices: PriceRow[] | undefined,
): number | null {
  if (!token.priceFeedShortId) return 1;
  if (!prices) return null;
  const feed = prices.find((p) => p.shortId === token.priceFeedShortId);
  if (!feed) return null;
  return Number(feed.answer) / 10 ** feed.feedDecimals;
}

function fmtAmount(n: number, decimals: number): string {
  const dp = decimals === 18 ? 5 : 2;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  });
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function pairKey(p: TokenPair): string {
  return `${p.symbol.toLowerCase()}:${p.chainId}`;
}

// ─── Trigger pill ───────────────────────────────────────────────────────

export function TokenSelectButton({
  token,
  open,
  onClick,
}: {
  token: TokenPair | null;
  open: boolean;
  onClick: () => void;
}) {
  const slug = token ? networkSlugForChainId(token.chainId) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => {
        // Stop the native pointerdown from bubbling to document, where
        // the dropdown's click-outside listener lives. Without this,
        // tapping the trigger while the dropdown is open does:
        //   pointerdown → close (via outside-handler) → re-render with
        //   pickerOpen=false → click fires with stale closure → toggle
        //   sees `false`, calls onClick(true) → reopens.
        // Stopping pointerdown propagation keeps the trigger's own
        // onClick the single source of truth for toggling.
        e.nativeEvent.stopPropagation();
      }}
      aria-expanded={open}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5",
        "rounded-full border border-line bg-card pl-1 pr-2 py-1",
        "text-sm font-semibold text-ink",
        "transition-colors hover:bg-paper-lo",
      )}
    >
      {token ? (
        <>
          {/* Disc + a tiny chain sub-dot in the bottom-right corner.
              Matches the badge shape used by TokenRow so the trigger
              and the picker agree on the same visual language. The
              chain *name* lives on the SideBox footer line so the pill
              stays compact and the placeholder/selected widths stay
              roughly aligned. */}
          <span className="relative">
            <AssetMark symbol={token.symbol} size={22} />
            {slug && (
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-card"
                style={{ background: chainDotColor(slug) }}
              />
            )}
          </span>
          <span>{token.symbol}</span>
        </>
      ) : (
        <span className="px-1 text-ink-mute">Pick token</span>
      )}
      <ChevronDown
        className={cn(
          "size-3.5 text-ink-mute transition-transform",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

function chainDotColor(slug: NetworkSlug): string {
  if (slug === "base") return "#0052FF";
  if (slug === "eth") return "#627EEA";
  return "currentColor";
}

function chainNameForId(chainId: number): string {
  if (chainId === 1) return "Ethereum";
  if (chainId === 8453) return "Base";
  return "this network";
}

// ─── Balance tiles ──────────────────────────────────────────────────────
// Quick-pick row used outside the dropdown — surfaces tokens the user
// already holds as compact tiles so they can populate the pay side in
// one tap. Hides itself entirely when the user has no balances, or
// when nothing on this side passes the counterpart-chain lock.

export function BalanceTiles({
  pairs,
  evmAddress,
  selected,
  counterpart,
  onSelect,
}: {
  pairs: TokenPair[];
  evmAddress: string;
  /** Currently-selected pair on this side (rendered with a ring). */
  selected: TokenPair | null;
  /** Selection on the other side; restricts tiles to its chain and
   *  hides the exact (symbol, chain) that's already over there. */
  counterpart: TokenPair | null;
  onSelect: (pair: TokenPair) => void;
}) {
  // Per-row balance lookups. Same shape as the dropdown — react-query
  // dedupes by queryKey so we're not double-fetching.
  const rows = pairs.map((pair) => {
    const pub = usePublicBalance(
      {
        chainId: pair.chainId,
        address: pair.address,
        symbol: pair.symbol,
        decimals: pair.decimals,
      },
      evmAddress,
    );
    const priv = usePrivateBalance(
      {
        chainId: pair.chainId,
        address: pair.address,
        symbol: pair.symbol,
        decimals: pair.decimals,
      },
      evmAddress,
    );
    const total = (pub.data?.balanceWei ?? 0n) + (priv.data?.balanceWei ?? 0n);
    return { pair, total };
  });

  const visible = rows.filter((r) => {
    if (r.total <= 0n) return false;
    if (counterpart && r.pair.chainId !== counterpart.chainId) return false;
    if (counterpart && pairKey(r.pair) === pairKey(counterpart)) return false;
    return true;
  });

  if (visible.length === 0) return null;
  return (
    // Right-aligned so the tiles sit under the trigger pill (which is
    // also on the right of the SideBox). flex-wrap handles overflow on
    // narrow modals; justify-end keeps wrapped rows right-aligned too.
    <div className="flex flex-wrap justify-end gap-1.5">
      {visible.map(({ pair }) => (
        <TokenTile
          key={pairKey(pair)}
          pair={pair}
          isSelected={selected !== null && pairKey(pair) === pairKey(selected)}
          onClick={() => onSelect(pair)}
        />
      ))}
    </div>
  );
}

// Tile row that surfaces swap-catalog tokens as quick-pick options.
// Bidirectional with the pay-side tiles: each side uses the OTHER
// side's selection as a chain anchor, so picking one side first
// constrains the other to the same chain.
//
//   - `counterpart` set → filter to its chain, exclude the exact
//     (symbol, chain) already on that side.
//   - `counterpart` null → show every pair in `pairs` so the row
//     doesn't look empty when neither side has been chosen yet.
//
// Distinct from `BalanceTiles`:
//   - no balance filter (you might be acquiring, not just moving what
//     you already hold), and
//   - no balance hooks → zero RPC cost regardless of how many pairs
//     the caller passes in.
export function ChainPeerTiles({
  pairs,
  selected,
  counterpart,
  onSelect,
}: {
  pairs: TokenPair[];
  /** Currently-selected pair on this side (rendered with a ring). */
  selected: TokenPair | null;
  /** Selection on the OTHER side. Constrains tiles to its chain when
   *  set; when null, no restriction (all `pairs` show). */
  counterpart: TokenPair | null;
  onSelect: (pair: TokenPair) => void;
}) {
  const visible = counterpart
    ? pairs.filter(
        (p) =>
          p.chainId === counterpart.chainId &&
          pairKey(p) !== pairKey(counterpart),
      )
    : pairs;
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {visible.map((pair) => (
        <TokenTile
          key={pairKey(pair)}
          pair={pair}
          isSelected={selected !== null && pairKey(pair) === pairKey(selected)}
          onClick={() => onSelect(pair)}
        />
      ))}
    </div>
  );
}

function TokenTile({
  pair,
  isSelected,
  onClick,
}: {
  pair: TokenPair;
  isSelected: boolean;
  onClick: () => void;
}) {
  const slug = networkSlugForChainId(pair.chainId);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      title={`${pair.symbol} on ${chainNameForId(pair.chainId)}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-0.5",
        "text-[11px] font-semibold text-ink",
        "transition-colors",
        isSelected
          ? "border-[var(--pub)] bg-[var(--pub-soft)]"
          : "border-line bg-paper-lo hover:bg-paper",
      )}
    >
      <span className="relative">
        <AssetMark symbol={pair.symbol} size={18} />
        {slug && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-paper-lo"
            style={{ background: chainDotColor(slug) }}
          />
        )}
      </span>
      <span>{pair.symbol}</span>
    </button>
  );
}

// ─── Dropdown ────────────────────────────────────────────────────────────

type RowState = {
  pair: TokenPair;
  publicWei: bigint | null;
  privateWei: bigint | null;
  priceUsd: number | null;
  /** true while the public OR private balance query is still pending
   *  its first fetch. We need this to distinguish "we know they have
   *  nothing" from "we haven't checked yet" — the cold-wallet
   *  auto-fallback below only fires once we're sure. */
  isLoading: boolean;
};

export function TokenDropdown({
  pairs,
  selected,
  counterpart,
  onSelect,
  onClose,
  evmAddress,
  prices,
  lockChainId,
  defaultFilter = "all",
}: {
  /** Full (token, chain) catalogue. Stable identity required. */
  pairs: TokenPair[];
  /** Currently-selected pair on this side (rendered with a check). */
  selected: TokenPair | null;
  /** Selection on the OTHER side; we hide it so the user can't pick
   *  the same (symbol, chain) twice. */
  counterpart: TokenPair | null;
  /** `null` is sent when the user clicks the header's Clear button. */
  onSelect: (pair: TokenPair | null) => void;
  onClose: () => void;
  evmAddress: string;
  prices: PriceRow[] | undefined;
  /** When set, restrict the picker to tokens on this chain only and
   *  hide the per-chain filter pills. Used by SwapModal so the user
   *  can't accidentally pick across chains when the other side is
   *  already locked in. */
  lockChainId?: number;
  /** Initial filter pill. Pay-side defaults to "mine" so the user
   *  lands on their balances; receive-side falls back to "all". */
  defaultFilter?: Filter;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>(defaultFilter);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // `(pointer: fine)` is true for mice / trackpads, false for touch.
  // Use it to decide whether to autofocus the search input on open:
  // desktop users get the keyboard-friendly flow; mobile users don't
  // get the on-screen keyboard popping up unsolicited.
  const hasFinePointer = useMediaQuery("(pointer: fine)");

  // Click-outside + Esc to close. The panel itself stops propagation so
  // inside clicks don't trip the outside handler.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "/" && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Auto-focus the search input on open for a keyboard-friendly flow.
  // Skipped on touch devices so the on-screen keyboard doesn't pop up
  // the instant the picker opens — the user is more likely to scan the
  // visible token list than to type, and the keyboard would hide most
  // of it. Tap the input directly to bring it up.
  useEffect(() => {
    if (!hasFinePointer) return;
    searchRef.current?.focus();
  }, [hasFinePointer]);

  // Per-row balance lookups. Safe inside .map() because `pairs` is
  // stable across renders (memoised by the parent). The hooks reuse
  // the same react-query cache the wallet dashboard populates, so
  // opening the picker doesn't trigger fresh RPC calls.
  const rows: RowState[] = pairs.map((pair) => {
    const pub = usePublicBalance(
      {
        chainId: pair.chainId,
        address: pair.address,
        symbol: pair.symbol,
        decimals: pair.decimals,
      },
      evmAddress,
    );
    const priv = usePrivateBalance(
      {
        chainId: pair.chainId,
        address: pair.address,
        symbol: pair.symbol,
        decimals: pair.decimals,
      },
      evmAddress,
    );
    return {
      pair,
      publicWei: pub.data?.balanceWei ?? null,
      privateWei: priv.data?.balanceWei ?? null,
      priceUsd: usdPriceFor(pair, prices),
      isLoading: pub.isLoading || priv.isLoading,
    };
  });

  const hasBalance = (r: RowState) =>
    (r.publicWei ?? 0n) + (r.privateWei ?? 0n) > 0n;

  // Cold-wallet auto-fallback: when the picker is told to default to
  // "mine" (pay side) but the user actually has zero balances of any
  // tracked asset, switch the initial filter to "all" so they aren't
  // greeted with an empty list. Only fires while still on the default
  // — once the user manually clicks a filter pill we never override
  // their choice. Gated on `allLoaded` so we don't flip to "all"
  // mid-load before the balance fetches resolve.
  const allLoaded = rows.every((r) => !r.isLoading);
  const noBalancesConfirmed = allLoaded && !rows.some(hasBalance);
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    if (autoSwitchedRef.current) return;
    if (defaultFilter !== "mine" || filter !== "mine") return;
    if (noBalancesConfirmed) {
      autoSwitchedRef.current = true;
      setFilter("all");
    }
  }, [defaultFilter, filter, noBalancesConfirmed]);

  const usdValue = (r: RowState) => {
    if (r.priceUsd === null) return 0;
    const total = (r.publicWei ?? 0n) + (r.privateWei ?? 0n);
    return weiToNumber(total, r.pair.decimals) * r.priceUsd;
  };

  // ── Filter pipeline ──
  const q = search.trim().toLowerCase();
  const matchesSearch = (p: TokenPair) =>
    !q ||
    p.symbol.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q);

  // Not memoised: `rows` is rebuilt every render (the balance hooks
  // return fresh objects), so any useMemo here would always miss
  // anyway. The work is O(N) over a small N — cheaper than the memo
  // bookkeeping.
  const visible = rows.filter((r) => {
    if (lockChainId !== undefined && r.pair.chainId !== lockChainId) {
      return false;
    }
    if (!matchesSearch(r.pair)) return false;
    // Hide the row that's currently picked on the OTHER side — picking
    // it would mean swapping a token with itself.
    if (counterpart && pairKey(r.pair) === pairKey(counterpart)) return false;
    if (filter === "mine") return hasBalance(r);
    if (filter === "all") return true;
    return networkSlugForChainId(r.pair.chainId) === filter;
  });

  // When chain-locked, the per-chain pills are hidden and the visible
  // sections collapse to one (the locked chain). The eth/base flags
  // below still gate the section, just guaranteed to single-section.
  const lockedSlug =
    lockChainId !== undefined ? networkSlugForChainId(lockChainId) : null;
  const showMine = filter === "all" || filter === "mine";
  const showEth =
    (filter === "all" || filter === "eth") &&
    (lockedSlug === null || lockedSlug === "eth");
  const showBase =
    (filter === "all" || filter === "base") &&
    (lockedSlug === null || lockedSlug === "base");

  const sections = {
    mine: showMine
      ? visible.filter(hasBalance).sort((a, b) => usdValue(b) - usdValue(a))
      : [],
    eth: showEth
      ? visible.filter(
          (r) =>
            !hasBalance(r) && networkSlugForChainId(r.pair.chainId) === "eth",
        )
      : [],
    base: showBase
      ? visible.filter(
          (r) =>
            !hasBalance(r) && networkSlugForChainId(r.pair.chainId) === "base",
        )
      : [],
  };

  const isEmpty =
    sections.mine.length === 0 &&
    sections.eth.length === 0 &&
    sections.base.length === 0;

  return (
    <div
      ref={panelRef}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute right-0 top-full z-50 mt-2 w-[320px]",
        "rounded-2xl border border-line bg-popover text-popover-foreground",
        "ring-1 ring-foreground/10",
        "flex flex-col overflow-hidden",
      )}
      // Shadow per the AssetSelect design spec — slightly stronger than
      // the modal's default so the popover reads as floating above it.
      style={{
        maxHeight: 420,
        boxShadow:
          "0 28px 64px rgba(12, 34, 54, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <h3 className="font-serif text-[15px] font-bold text-ink">
          Select token
        </h3>
        <div className="flex items-center gap-1">
          {selected && (
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-ink-mute hover:bg-paper-lo hover:text-ink-soft"
              title="Clear selection"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-ink-mute hover:bg-paper-lo"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="px-3 pt-2">
        <div className="flex items-center gap-1.5 rounded-xl bg-paper-lo px-2.5 py-1.5">
          <Search className="size-3.5 text-ink-mute" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or ticker"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-mute"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
        <FilterPill
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label="All"
        />
        <FilterPill
          active={filter === "mine"}
          onClick={() => setFilter("mine")}
          label="My tokens"
        />
        {/* Per-chain pills hidden when locked — the other side already
            dictates the chain, and showing them would imply the user
            could switch chains here. */}
        {lockChainId === undefined && (
          <>
            <FilterPill
              active={filter === "eth"}
              onClick={() => setFilter("eth")}
              network="eth"
              label="Ethereum"
            />
            <FilterPill
              active={filter === "base"}
              onClick={() => setFilter("base")}
              network="base"
              label="Base"
            />
          </>
        )}
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        {isEmpty ? (
          <p className="px-2 py-8 text-center text-[12.5px] text-ink-mute">
            {filter === "mine" && noBalancesConfirmed
              ? "You have no token balances."
              : lockChainId !== undefined && q.length === 0 && filter === "all"
                ? `No other assets to swap to on ${chainNameForId(lockChainId)}.`
                : "Nothing found."}
          </p>
        ) : (
          <>
            {sections.mine.length > 0 && (
              <Section
                eyebrow="My tokens"
                count={sections.mine.length}
                rows={sections.mine}
                selected={selected}
                showBalances
                onSelect={onSelect}
              />
            )}
            {sections.eth.length > 0 && (
              <Section
                eyebrow="On Ethereum"
                count={sections.eth.length}
                rows={sections.eth}
                selected={selected}
                showBalances={false}
                onSelect={onSelect}
              />
            )}
            {sections.base.length > 0 && (
              <Section
                eyebrow="On Base"
                count={sections.base.length}
                rows={sections.base}
                selected={selected}
                showBalances={false}
                onSelect={onSelect}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function FilterPill({
  active,
  onClick,
  label,
  network,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  network?: NetworkSlug;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        "transition-colors",
        active
          ? "bg-ink text-paper"
          : "border border-line bg-transparent text-ink-soft hover:bg-paper-lo",
      )}
    >
      {network && <NetDot network={network} />}
      {label}
    </button>
  );
}

function NetDot({ network }: { network: NetworkSlug }) {
  // Inline dot matching the colour token used by .net-chip in styles.css.
  return (
    <span
      aria-hidden
      className="inline-block size-1.5 rounded-full"
      style={{ background: chainDotColor(network) }}
    />
  );
}

function Section({
  eyebrow,
  count,
  rows,
  selected,
  showBalances,
  onSelect,
}: {
  eyebrow: string;
  count: number;
  rows: RowState[];
  selected: TokenPair | null;
  showBalances: boolean;
  onSelect: (pair: TokenPair) => void;
}) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 flex items-baseline justify-between px-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-mute">
          {eyebrow}
        </span>
        <span className="text-[10px] font-mono text-ink-mute">{count}</span>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={pairKey(r.pair)}>
            <TokenRow
              row={r}
              selected={
                selected !== null && pairKey(r.pair) === pairKey(selected)
              }
              showBalances={showBalances}
              onClick={() => onSelect(r.pair)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TokenRow({
  row,
  selected,
  showBalances,
  onClick,
}: {
  row: RowState;
  selected: boolean;
  showBalances: boolean;
  onClick: () => void;
}) {
  const slug = networkSlugForChainId(row.pair.chainId);
  const pubAmt = row.publicWei
    ? weiToNumber(row.publicWei, row.pair.decimals)
    : 0;
  const privAmt = row.privateWei
    ? weiToNumber(row.privateWei, row.pair.decimals)
    : 0;
  const totalAmt = pubAmt + privAmt;
  const totalUsd = row.priceUsd !== null ? totalAmt * row.priceUsd : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/row grid w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors",
        "grid-cols-[auto_1fr_auto_auto]",
        "hover:bg-foreground/5",
        selected && "bg-[var(--pub-soft)]",
      )}
    >
      {/* Asset disc + network sub-dot */}
      <span className="relative">
        <AssetMark symbol={row.pair.symbol} size={30} />
        {slug && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border border-popover"
            style={{ background: chainDotColor(slug) }}
          />
        )}
      </span>

      <span className="flex min-w-0 flex-col">
        <span className="flex items-baseline gap-1.5">
          <span className="font-serif text-[14px] font-bold text-ink leading-none">
            {row.pair.symbol}
          </span>
          <span className="truncate text-[12px] text-ink-mute">
            {row.pair.name}
          </span>
        </span>
        {showBalances ? (
          <span className="mt-1 inline-flex items-center gap-2 font-mono text-[10.5px] text-ink-mute">
            <span className="inline-flex items-center gap-1 text-[var(--pub)]">
              <SunIcon size={9} /> {fmtAmount(pubAmt, row.pair.decimals)}
            </span>
            <span className="inline-flex items-center gap-1 text-[var(--priv)]">
              <MoonIcon size={9} /> {fmtAmount(privAmt, row.pair.decimals)}
            </span>
          </span>
        ) : (
          slug && (
            <span className="mt-1">
              <NetworkChip network={slug} />
            </span>
          )
        )}
      </span>

      <span className="text-right">
        {showBalances ? (
          <>
            <span className="block font-mono text-[12.5px] font-semibold text-ink">
              {fmtAmount(totalAmt, row.pair.decimals)}
            </span>
            {totalUsd !== null && (
              <span className="block font-mono text-[10px] text-ink-mute">
                {fmtUsd(totalUsd)}
              </span>
            )}
          </>
        ) : (
          row.priceUsd !== null && (
            <span className="font-mono text-[11px] text-ink-mute">
              {fmtUsd(row.priceUsd)}
            </span>
          )
        )}
      </span>

      <span className="w-4">
        {selected && <Check className="size-3.5 text-[var(--pub)]" />}
      </span>
    </button>
  );
}

import { Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { weiToNumber } from "@/lib/balances";
import { AssetMark } from "./AssetMark";
import {
  NetworkChip,
  networkSlugForChainId,
  type NetworkSlug,
} from "./NetworkChip";
import { SplitBar } from "./SplitBar";
import { SunIcon, MoonIcon } from "./SunMoonIcons";

export type AssetRowData = {
  symbol: string;
  name: string;
  decimals: number;
  /** Display precision. Defaults to a sensible per-symbol value. */
  roundTo?: number;
  /** USD price per whole token. null → render token amount but no USD. */
  priceUsd: number | null;
  /** Public/on-chain balance, in wei (or token's smallest unit). */
  publicWei: bigint | null;
  /** Shielded balance. null while the (placeholder) hook is loading. */
  privateWei: bigint | null;
  /** Chains where this asset is supported, for the chip row. */
  chainIds: number[];
};

/**
 * "shield" → move public → private. "unshield" → private → public.
 */
export type MoveIntent = "shield" | "unshield";

function fmtToken(n: number, dp: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function fmtUsd(n: number, dp = 2): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

const DEFAULT_ROUND_TO: Partial<Record<string, number>> = {
  ETH: 5,
  USDC: 2,
  AUDD: 2,
};

const SKEL_USD: React.CSSProperties = {
  width: 56,
  height: 14,
  display: "inline-block",
};
const SKEL_TOKEN: React.CSSProperties = {
  width: 64,
  height: 14,
  display: "inline-block",
};
const SKEL_TOKEN_SMALL: React.CSSProperties = {
  width: 70,
  height: 11,
  display: "inline-block",
};

export function AssetRow({
  asset,
  onMove,
  className,
}: {
  asset: AssetRowData;
  onMove?: (intent: MoveIntent) => void;
  className?: string;
}) {
  const dp = asset.roundTo ?? DEFAULT_ROUND_TO[asset.symbol] ?? 4;

  const pubKnown = asset.publicWei !== null;
  const privKnown = asset.privateWei !== null;
  const pubAmt = pubKnown ? weiToNumber(asset.publicWei!, asset.decimals) : 0;
  const privAmt = privKnown
    ? weiToNumber(asset.privateWei!, asset.decimals)
    : 0;
  const totalAmt = pubAmt + privAmt;
  const totalUsd = asset.priceUsd !== null ? totalAmt * asset.priceUsd : null;
  // Bar geometry is USD-weighted when we have a price, token-weighted
  // otherwise.
  const pubVal = asset.priceUsd !== null ? pubAmt * asset.priceUsd : pubAmt;
  const privVal = asset.priceUsd !== null ? privAmt * asset.priceUsd : privAmt;

  const chipSlugs = asset.chainIds
    .map(networkSlugForChainId)
    .filter((s): s is NetworkSlug => s !== null);

  // Shared sub-bits keep mobile + desktop in lockstep.
  // Stack symbol over name so long names (e.g. "Australian Digital Dollar")
  // wrap cleanly under the symbol rather than next to it.
  const ticker = (
    <div className="flex flex-col items-start gap-0.5 min-w-0">
      <span className="font-bold text-[15px] text-ink leading-tight">
        {asset.symbol}
      </span>
      <span className="text-[12.5px] text-ink-mute leading-snug break-words">
        {asset.name}
      </span>
    </div>
  );
  const chips = (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {chipSlugs.map((slug) => (
        <NetworkChip key={slug} network={slug} />
      ))}
    </div>
  );
  const usdAndAmount = (
    <div className="text-right shrink-0">
      {totalUsd === null ? (
        <span className="skel" style={SKEL_USD} />
      ) : (
        <div className="font-mono text-[14px] font-semibold text-ink">
          {fmtUsd(totalUsd)}
        </div>
      )}
      {pubKnown && privKnown ? (
        <div className="mt-0.5 font-mono text-[11px] text-ink-mute">
          {fmtToken(totalAmt, dp)} {asset.symbol}
        </div>
      ) : (
        <span className="skel mt-0.5" style={SKEL_TOKEN_SMALL} />
      )}
    </div>
  );
  const publicColumn = (alignRight = false) => (
    <div className={alignRight ? "text-right" : undefined}>
      <div
        className={cn(
          "inline-flex items-center gap-1.5 text-[var(--pub)]",
        )}
      >
        <SunIcon size={11} />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em]">
          Public
        </span>
      </div>
      <div className="mt-0.5 font-mono text-[13.5px] font-semibold text-ink">
        {pubKnown ? (
          fmtToken(pubAmt, dp)
        ) : (
          <span className="skel" style={SKEL_TOKEN} />
        )}
      </div>
    </div>
  );
  const privateColumn = (alignRight = false) => (
    <div className={alignRight ? "text-right" : undefined}>
      <div className="inline-flex items-center gap-1.5 text-[var(--priv)]">
        {alignRight ? (
          <>
            <span className="text-[10px] font-bold uppercase tracking-[0.14em]">
              Private
            </span>
            <MoonIcon size={10} />
          </>
        ) : (
          <>
            <MoonIcon size={10} />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em]">
              Private
            </span>
          </>
        )}
      </div>
      <div className="mt-0.5 font-mono text-[13.5px] font-semibold text-ink">
        {privKnown ? (
          fmtToken(privAmt, dp)
        ) : (
          <span className="skel" style={SKEL_TOKEN} />
        )}
      </div>
    </div>
  );

  return (
    <div className={cn("rounded-3xl card-cream p-4 sm:p-[18px]", className)}>
      {/* ─── Mobile: vertical card with Shield + Unshield buttons ─── */}
      <div className="flex flex-col gap-3.5 sm:hidden">
        <div className="flex items-center gap-3">
          <AssetMark symbol={asset.symbol} size={36} />
          <div className="flex-1 min-w-0">
            {ticker}
            {chips}
          </div>
          {usdAndAmount}
        </div>

        <div>
          <div className="mb-2 flex items-end justify-between">
            {publicColumn(false)}
            {privateColumn(true)}
          </div>
          <SplitBar publicValue={pubVal} privateValue={privVal} height={10} />
        </div>

        {onMove && (
          <div className="flex gap-2">
            <GhostButton
              tone="priv"
              icon={<Shield className="size-3.5" />}
              onClick={() => onMove("shield")}
            >
              Shield
            </GhostButton>
            <GhostButton
              tone="pub"
              icon={<SunIcon size={13} />}
              onClick={() => onMove("unshield")}
            >
              Unshield
            </GhostButton>
          </div>
        )}
      </div>

      {/* ─── Desktop: horizontal row ─── */}
      <div className="hidden sm:flex sm:items-center sm:gap-5">
        <AssetMark symbol={asset.symbol} size={42} />

        <div className="w-[170px] shrink-0 min-w-0">
          {ticker}
          {chips}
        </div>

        <div className="w-[100px] shrink-0">{publicColumn(false)}</div>
        <div className="w-[100px] shrink-0">{privateColumn(false)}</div>

        <div className="flex-1 min-w-[80px]">
          <SplitBar publicValue={pubVal} privateValue={privVal} height={10} />
          <div className="mt-2 text-right font-mono text-[11px] text-ink-mute">
            {pubKnown && privKnown ? (
              <>
                {totalUsd !== null ? `${fmtUsd(totalUsd, 2)} · ` : ""}
                {fmtToken(totalAmt, dp)} total
              </>
            ) : (
              <span className="skel" style={{ width: 100, height: 11 }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Pill button matching `.btn-ghost-pub` / `.btn-ghost-priv` from the
// design handoff: filled with the soft tone, hover bumps to soft-2.
function GhostButton({
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
        "flex-1 inline-flex h-[38px] items-center justify-center gap-1.5",
        "rounded-full text-[13px] font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-3",
        tone === "priv"
          ? [
              "bg-[var(--priv-soft)] text-[var(--priv)]",
              "hover:bg-[var(--priv-soft-2)]",
              "focus-visible:ring-[var(--priv-soft-2)]",
            ]
          : [
              "bg-[var(--pub-soft)] text-[var(--pub)]",
              "hover:bg-[var(--pub-soft-2)]",
              "focus-visible:ring-[var(--pub-soft-2)]",
            ],
      )}
    >
      {icon}
      {children}
    </button>
  );
}

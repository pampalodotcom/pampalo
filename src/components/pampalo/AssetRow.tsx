import { useEffect, useState } from "react";
import { parseUnits } from "ethers";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { weiToNumber } from "@/lib/balances";
import { AssetMark } from "./AssetMark";
import {
  NetworkChip,
  networkSlugForChainId,
  type NetworkSlug,
} from "./NetworkChip";
import {
  PendingShieldsList,
  type CancelRequest,
} from "./PendingShieldsList";
import { SplitBar } from "./SplitBar";
import { SplitSlider } from "./SplitSlider";
import { SunIcon, MoonIcon } from "./SunMoonIcons";
import type { PendingNote } from "@/lib/use-private-balances";

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

/** "shield" → move public → private. "unshield" → private → public. */
export type MoveIntent = "shield" | "unshield";

export type MovePayload = {
  intent: MoveIntent;
  /** Token base units (wei for ETH, 6-decimal units for USDC, etc.). */
  amount: bigint;
  /** Which chain the user wants to move on. v1 = first supported chain. */
  chainId: number;
  symbol: string;
  decimals: number;
};

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
  /**
   * True when the asset has a corresponding `pampaloAssets` entry on at
   * least one of its chains — i.e. the user can actually queue a shield
   * here. When false the row renders a static SplitBar (no handle, no
   * Cancel/Confirm row) so we don't promise an action we can't honour.
   */
  shieldable = false,
  /**
   * Lower bound on the slider's `pub` value, in display units. The
   * parent computes this from the user's remaining monthly shield cap
   * so the slider can't be dragged past the budget that the contract
   * would enforce anyway. Undefined → no constraint (slider can go to 0).
   */
  minPub,
  /** When set, a shield/unshield broadcast for this asset is mining;
   *  the slider locks and the action row swaps for a calm "Confirming
   *  on-chain…" banner until the wallet-level receipt poll clears it. */
  confirmingKind = null,
  /** Notes still counting down to unlock. Drives the collapsable list. */
  queuedNotes,
  /** Notes whose unlockTime has passed; user can finalise. */
  executableNotes,
  /** Per-note finalise handler. */
  onFinalise,
  /** Cancel a still-queued pending shield (refunds the shielder). */
  onCancel,
  className,
}: {
  asset: AssetRowData;
  onMove?: (payload: MovePayload) => void;
  shieldable?: boolean;
  minPub?: number;
  confirmingKind?: "shield" | "unshield" | null;
  queuedNotes?: PendingNote[];
  executableNotes?: PendingNote[];
  onFinalise?: (note: PendingNote) => void;
  onCancel?: (req: CancelRequest) => void;
  className?: string;
}) {
  const dp = asset.roundTo ?? DEFAULT_ROUND_TO[asset.symbol] ?? 4;

  const pubKnown = asset.publicWei !== null;
  const privKnown = asset.privateWei !== null;
  const originalPub = pubKnown
    ? weiToNumber(asset.publicWei!, asset.decimals)
    : 0;
  const originalPriv = privKnown
    ? weiToNumber(asset.privateWei!, asset.decimals)
    : 0;
  const total = originalPub + originalPriv;

  // Local drag state. The parent owns the chain truth (`asset.*Wei`);
  // we track what the user has dragged to and feed it to onMove on
  // confirm. Reset when the asset identity changes so the same row
  // component reused across symbols doesn't carry stale drag.
  const [pub, setPub] = useState(originalPub);
  useEffect(() => {
    setPub(originalPub);
  }, [asset.symbol, originalPub]);

  const priv = Math.max(0, total - pub);
  const delta = pub - originalPub; // negative = shielding; positive = unshielding
  const moveAmt = Math.abs(delta);
  const dirty = moveAmt > 1e-9;
  const direction: MoveIntent = delta < 0 ? "shield" : "unshield";

  // Live USD display reflects the dragged split, not the on-chain one,
  // so the user can see the dollar impact of their proposed move.
  const totalUsd = asset.priceUsd !== null ? total * asset.priceUsd : null;

  const chipSlugs = asset.chainIds
    .map(networkSlugForChainId)
    .filter((s): s is NetworkSlug => s !== null);

  // v1 multi-network select isn't built yet (SHIELD_FLOW.md §9.1). The
  // active chain is just the first chip until that lands.
  const activeChainId = asset.chainIds[0];

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
          {fmtToken(total, dp)} {asset.symbol}
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
          dirty && direction === "shield" && "opacity-55",
        )}
      >
        <SunIcon size={11} />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em]">
          Public
        </span>
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[13.5px] font-semibold text-ink",
          dirty && direction === "shield" && "opacity-55",
        )}
      >
        {pubKnown ? (
          fmtToken(pub, dp)
        ) : (
          <span className="skel" style={SKEL_TOKEN} />
        )}
      </div>
    </div>
  );
  const privateColumn = (alignRight = false) => (
    <div className={alignRight ? "text-right" : undefined}>
      <div
        className={cn(
          "inline-flex items-center gap-1.5 text-[var(--priv)]",
          dirty && direction === "unshield" && "opacity-55",
        )}
      >
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
      <div
        className={cn(
          "mt-0.5 font-mono text-[13.5px] font-semibold text-ink",
          dirty && direction === "unshield" && "opacity-55",
        )}
      >
        {privKnown ? (
          fmtToken(priv, dp)
        ) : (
          <span className="skel" style={SKEL_TOKEN} />
        )}
      </div>
    </div>
  );

  // USD-weighted values for the static bar (same maths as the original
  // pre-slider AssetRow used). Only consulted when !shieldable.
  const pubVal =
    asset.priceUsd !== null ? originalPub * asset.priceUsd : originalPub;
  const privVal =
    asset.priceUsd !== null ? originalPriv * asset.priceUsd : originalPriv;

  // Lock the slider while a tx is mining so the user can't drag a
  // fresh move on top of a still-confirming one. We render the
  // static SplitBar variant instead of the interactive slider in
  // that window; it visually conveys the same balance split without
  // the affordance to drag.
  const slider =
    shieldable && confirmingKind === null ? (
      <SplitSlider
        pub={pub}
        total={total}
        originalPub={originalPub}
        onChange={setPub}
        decimals={dp}
        ticker={asset.symbol}
        minPub={minPub}
      />
    ) : (
      <SplitBar publicValue={pubVal} privateValue={privVal} height={10} />
    );

  const handleCancel = () => setPub(originalPub);
  const handleConfirm = () => {
    if (!dirty || !onMove || asset.chainIds.length === 0) return;
    // Snap to the row's display precision (`dp`) so the broadcast
    // amount matches what the user sees on the button label — no more
    // 5.000466 USDC from a drag that *looks* like 5.00. Endpoint cases
    // (shield-all or unshield-all) use the exact wei from the source
    // balance so the user can fully empty a side without trailing dust
    // in the other direction.
    let amount: bigint;
    const atShieldAll = direction === "shield" && pub <= 1e-9;
    const atUnshieldAll = direction === "unshield" && priv <= 1e-9;
    if (atShieldAll && asset.publicWei !== null) {
      amount = asset.publicWei;
    } else if (atUnshieldAll && asset.privateWei !== null) {
      amount = asset.privateWei;
    } else {
      const precision = Math.min(asset.decimals, dp);
      amount = parseUnits(moveAmt.toFixed(precision), asset.decimals);
    }
    onMove({
      intent: direction,
      amount,
      chainId: activeChainId,
      symbol: asset.symbol,
      decimals: asset.decimals,
    });
  };

  // Action row: idle hint when nothing has moved off baseline, swap to
  // Cancel + Confirm pair when the user has dragged. Omit entirely when
  // the asset isn't shieldable on any of its chains. While a tx is
  // confirming on-chain (wallet-level pendingMoves set), every other
  // state yields to a calm "Confirming…" pill.
  let actionRow: React.ReactNode = null;
  if (confirmingKind !== null) {
    actionRow = (
      <div
        className={cn(
          "flex h-[42px] items-center justify-center gap-2 rounded-full",
          "border border-line bg-paper-lo",
          "text-[12.5px] font-semibold",
          confirmingKind === "shield"
            ? "text-[var(--priv)]"
            : "text-[var(--pub)]",
        )}
        aria-live="polite"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {confirmingKind === "shield" ? "Shielding…" : "Unshielding…"} on-chain
      </div>
    );
  } else if (!shieldable) {
    // no idle hint, no buttons
  } else if (total > 0 && !dirty) {
    actionRow = (
      <div className="flex h-[38px] items-center justify-center gap-2 text-[12.5px] text-ink-mute">
        <span aria-hidden="true">🛡</span>
        <span>Drag the handle to shield or unshield</span>
        <span aria-hidden="true">☀</span>
      </div>
    );
  } else if (total > 0 && dirty) {
    // Action row: stacks vertically by default with the primary
    // Confirm button on TOP (matches the user's reach-target
    // expectation — primary action is closest to thumb / cursor).
    // `lg:flex-row-reverse` swaps to the familiar horizontal layout at
    // lg+ where there's room: Cancel on the left, Confirm on the right.
    actionRow = (
      <div className="flex flex-col gap-2 lg:flex-row-reverse">
        <button
          type="button"
          onClick={handleConfirm}
          className={cn(
            "inline-flex h-[42px] w-full lg:flex-1 items-center justify-center gap-2",
            "rounded-full text-[14px] font-bold text-white shadow-sm",
            "whitespace-nowrap px-3",
            "transition-colors focus-visible:outline-none focus-visible:ring-3",
            direction === "shield"
              ? [
                  "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]",
                  "focus-visible:ring-[var(--priv-soft-2)]",
                ]
              : [
                  "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
                  "focus-visible:ring-[var(--pub-soft-2)]",
                ],
          )}
        >
          {direction === "shield" ? (
            <MoonIcon size={14} />
          ) : (
            <SunIcon size={14} />
          )}
          <span className="truncate">
            {direction === "shield" ? "Shield" : "Unshield"}{" "}
            {fmtToken(moveAmt, dp)} {asset.symbol}
          </span>
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className={cn(
            "inline-flex h-[42px] w-full lg:w-[96px] lg:shrink-0 items-center justify-center",
            "rounded-full border border-line bg-transparent",
            "text-[13.5px] font-semibold text-ink",
            "transition-colors hover:bg-paper-lo",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ink-faint",
          )}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className={cn("rounded-3xl card-cream p-4 sm:p-[18px]", className)}>
      {/* ─── Mobile: vertical card ─── */}
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
          {slider}
        </div>

        {actionRow}

        <PendingShieldsList
          symbol={asset.symbol}
          decimals={asset.decimals}
          queuedNotes={queuedNotes ?? []}
          executableNotes={executableNotes ?? []}
          onFinalise={onFinalise}
          onCancel={onCancel}
          priceUsd={asset.priceUsd}
          roundTo={asset.roundTo}
        />
      </div>

      {/* ─── Desktop: horizontal row with action stack on the right ─── */}
      <div className="hidden sm:flex sm:items-center sm:gap-5">
        <AssetMark symbol={asset.symbol} size={42} />

        <div className="w-[170px] shrink-0 min-w-0">
          {ticker}
          {chips}
        </div>

        <div className="w-[100px] shrink-0">{publicColumn(false)}</div>
        <div className="w-[100px] shrink-0">{privateColumn(false)}</div>

        <div className="flex-1 min-w-[80px]">
          {slider}
          <div className="mt-2 text-right font-mono text-[11px] text-ink-mute">
            {pubKnown && privKnown ? (
              <>
                {totalUsd !== null ? `${fmtUsd(totalUsd, 2)} · ` : ""}
                {fmtToken(total, dp)} total
              </>
            ) : (
              <span className="skel" style={{ width: 100, height: 11 }} />
            )}
          </div>
          {/* Action row sits under the desktop slider so the layout
              doesn't reflow when the user starts dragging. Omitted
              entirely when the asset isn't shieldable, so the card
              doesn't carry empty whitespace. */}
          {actionRow !== null && <div className="mt-3">{actionRow}</div>}
          <PendingShieldsList
            symbol={asset.symbol}
            decimals={asset.decimals}
            queuedNotes={queuedNotes ?? []}
            executableNotes={executableNotes ?? []}
            onFinalise={onFinalise}
            onCancel={onCancel}
            priceUsd={asset.priceUsd}
            roundTo={asset.roundTo}
          />
        </div>
      </div>
    </div>
  );
}

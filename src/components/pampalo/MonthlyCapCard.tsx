import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Gauge } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { isTestnetChainId, usePreferences } from "@/lib/preferences";
import { useShieldBudget } from "@/lib/use-shield-budget";
import { useUnshieldBudget } from "@/lib/use-unshield-budget";
import { cn } from "@/lib/utils";

// Monthly-cap tracker for /account. The contract enforces a per-address
// USD cap PER CHAIN, independently for shield (money made private) and
// unshield (money made public), reset on each UTC calendar month. So we
// show one section per enabled deployment, each with two bars. Mainnet
// (Base) is shown by default; testnets only when the pref is on — matching
// the dashboard balance split. Caps come from the on-chain
// `effectiveCapUsdCents`, so a finance-manager per-address override renders
// correctly without the client hard-coding $200.

function fmtUsdCents(cents: bigint): string {
  const dollars = Number(cents) / 100;
  // Drop the cents when it's a round dollar amount (e.g. the $200 cap).
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

// First day of next UTC month — when both buckets reset.
function resetLabel(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return next.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function MonthlyCapCard({ evm }: { evm: string }) {
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const prefs = usePreferences();

  const chains = useMemo(() => {
    const rows = (deployments ?? [])
      .map((d) => ({ chainId: d.chainId, networkName: d.networkName }))
      .filter((d) => prefs.showTestnets || !isTestnetChainId(d.chainId));
    // Mainnet first, then testnets, stable within each by chainId.
    return rows.sort((a, b) => {
      const at = isTestnetChainId(a.chainId) ? 1 : 0;
      const bt = isTestnetChainId(b.chainId) ? 1 : 0;
      return at - bt || a.chainId - b.chainId;
    });
  }, [deployments, prefs.showTestnets]);

  if (chains.length === 0) return null;

  return (
    <section className="rise-in rounded-3xl card-cream px-5 py-5">
      <div className="mb-1 flex items-center gap-2">
        <Gauge className="size-4 text-ink-mute" />
        <p className="eyebrow">Monthly limits</p>
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-soft">
        How much you’ve moved between public and private this month. Limits are
        per network and reset on{" "}
        <span className="font-semibold text-ink">{resetLabel()} (UTC)</span>.
      </p>

      <div className="flex flex-col gap-4">
        {chains.map((c) => (
          <ChainCapSection
            key={c.chainId}
            chainId={c.chainId}
            networkName={c.networkName}
            user={evm}
          />
        ))}
      </div>
    </section>
  );
}

function ChainCapSection({
  chainId,
  networkName,
  user,
}: {
  chainId: number;
  networkName: string;
  user: string;
}) {
  const shield = useShieldBudget(chainId, user, true);
  const unshield = useUnshieldBudget(chainId, user, true);

  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-3">
      <p className="mb-2.5 text-[13px] font-semibold text-ink">{networkName}</p>
      <div className="flex flex-col gap-3">
        <CapBar
          label="Shielded this month"
          used={shield?.usdCentsUsedThisMonth ?? null}
          cap={shield?.effectiveCapUsdCents ?? null}
          tone="private"
        />
        <CapBar
          label="Unshielded this month"
          used={unshield?.usdCentsUsedThisMonth ?? null}
          cap={unshield?.effectiveCapUsdCents ?? null}
          tone="public"
        />
      </div>
    </div>
  );
}

function CapBar({
  label,
  used,
  cap,
  tone,
}: {
  label: string;
  used: bigint | null;
  cap: bigint | null;
  tone: "private" | "public";
}) {
  const loading = used === null || cap === null;
  const pct =
    used !== null && cap !== null && cap > 0n
      ? Math.min(100, Number((used * 10000n) / cap) / 100)
      : 0;
  const remaining =
    used !== null && cap !== null ? (used >= cap ? 0n : cap - used) : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">{label}</span>
        {loading ? (
          <span className="skel" style={{ width: 90, height: 12 }} />
        ) : (
          <span className="font-mono text-[12px] text-ink">
            {fmtUsdCents(used)}{" "}
            <span className="text-ink-mute">/ {fmtUsdCents(cap)}</span>
          </span>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-paper-lo">
        {!loading && (
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              tone === "private"
                ? "bg-[var(--priv)]"
                : "bg-[var(--pub)]",
            )}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {!loading && remaining !== null && (
        <p className="mt-1 text-[11px] text-ink-mute">
          {remaining === 0n
            ? "Limit reached for this month"
            : `${fmtUsdCents(remaining)} remaining`}
        </p>
      )}
    </div>
  );
}

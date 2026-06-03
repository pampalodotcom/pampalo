import { useQuery } from "convex/react";
import { ChevronRight, Check } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { NetworkLogo } from "@/components/pampalo/deposit/NetworkLogo";
import { SunIcon, MoonIcon } from "@/components/pampalo/SunMoonIcons";
import type { SendMode } from "./SendSheet";

// Step 1 — mode toggle + network selection.
//
// The mode toggle is the same accent-swapping pattern the deposit
// sheet uses. The network grid is gated on Pampalo deployments for
// private mode (only chains with a Pampalo router can do shielded
// sends) and on the catalog for public mode.

export function SendPickStep({
  mode,
  onModeChange,
  chainId,
  onChainChange,
  onContinue,
}: {
  mode: SendMode;
  onModeChange: (next: SendMode) => void;
  chainId: number | null;
  onChainChange: (next: number) => void;
  onContinue: () => void;
}) {
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});
  const networks = useQuery(api.catalog.networks.list, {});

  // Private mode only lists Pampalo-deployed chains. Public mode lists
  // the full catalog. Both lists collapse to "Base Sepolia" for the
  // demo, but the structure is right for adding mainnet later.
  const choices: Array<{ chainId: number; name: string }> = (() => {
    if (mode === "private") {
      return (deployments ?? []).map((d) => ({
        chainId: d.chainId,
        name: d.networkName,
      }));
    }
    return (networks ?? []).map((n) => ({
      chainId: n.chainId,
      name: n.name,
    }));
  })();

  const continueDisabled = chainId === null;
  const accent = mode === "private" ? "priv" : "pub";

  return (
    <div className="flex flex-col gap-5 px-5 pt-2 pb-5 sm:px-6 sm:pt-3 sm:pb-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="font-serif text-[22px] font-bold tracking-[-0.01em] text-ink">
          How do you want to send?
        </h2>
        <p className="text-[13px] text-ink-mute">
          Spending from your{" "}
          <span
            className={cn(
              "font-semibold",
              accent === "priv" ? "text-[var(--priv)]" : "text-[var(--pub)]",
            )}
          >
            {accent === "priv" ? "shielded" : "public"}
          </span>{" "}
          balance.
        </p>
      </div>

      {/* Mode toggle — segmented pill with a sliding accent fill. */}
      <div
        role="tablist"
        aria-label="Send mode"
        className={cn(
          "relative grid grid-cols-2 rounded-full p-1",
          "border border-line bg-paper-lo",
        )}
      >
        <ModeTab
          active={mode === "public"}
          accent="pub"
          icon={<SunIcon className="size-3.5" />}
          label="Public"
          onClick={() => onModeChange("public")}
        />
        <ModeTab
          active={mode === "private"}
          accent="priv"
          icon={<MoonIcon className="size-3.5" />}
          label="Private"
          onClick={() => onModeChange("private")}
        />
      </div>

      <p
        className={cn(
          "text-[12.5px] -mt-2",
          accent === "priv" ? "text-[var(--priv)]" : "text-[var(--pub)]",
        )}
      >
        {mode === "private" ? (
          <>
            <MoonIcon className="inline size-3 mr-1" /> Shielded — only the
            recipient can decrypt it.
          </>
        ) : (
          <>
            <SunIcon className="inline size-3 mr-1" /> Visible on-chain. Anyone
            can see it.
          </>
        )}
      </p>

      <div>
        <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-ink-mute">
          Network
        </p>
        {choices.length === 0 ? (
          <div className="rounded-2xl border border-line bg-paper-lo px-4 py-6 text-center text-[12.5px] text-ink-mute">
            {mode === "private"
              ? "No shielded-send networks available yet."
              : "Loading networks…"}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {choices.map((c) => (
              <NetworkChoiceCard
                key={c.chainId}
                chainId={c.chainId}
                name={c.name}
                selected={chainId === c.chainId}
                accent={accent}
                onClick={() => onChainChange(c.chainId)}
              />
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onContinue}
        disabled={continueDisabled}
        className={cn(
          "inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-full",
          "text-[14px] font-bold text-white shadow-sm",
          accent === "priv"
            ? "bg-gradient-to-b from-[var(--priv-hi)] to-[var(--priv)]"
            : "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
          "disabled:cursor-not-allowed disabled:opacity-55",
        )}
      >
        Continue
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function ModeTab({
  active,
  accent,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  accent: "pub" | "priv";
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-full",
        "text-[13px] font-semibold transition-colors",
        active
          ? accent === "priv"
            ? "bg-[var(--priv-soft)] text-[var(--priv)]"
            : "bg-[var(--pub-soft)] text-[var(--pub)]"
          : "text-ink-mute hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function NetworkChoiceCard({
  chainId,
  name,
  selected,
  accent,
  onClick,
}: {
  chainId: number;
  name: string;
  selected: boolean;
  accent: "pub" | "priv";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "relative flex min-h-[110px] flex-col justify-between rounded-2xl",
        "border bg-card p-3 text-left",
        "transition-colors",
        selected
          ? accent === "priv"
            ? "border-[var(--priv)] bg-[color-mix(in_oklab,var(--priv-soft)_60%,transparent)]"
            : "border-[var(--pub)] bg-[color-mix(in_oklab,var(--pub-soft)_60%,transparent)]"
          : "border-line hover:bg-paper-lo",
      )}
    >
      <NetworkLogo chainId={chainId} size={32} />
      {selected && (
        <span
          className={cn(
            "absolute right-2.5 top-2.5 inline-flex size-5 items-center justify-center rounded-full text-white",
            accent === "priv" ? "bg-[var(--priv)]" : "bg-[var(--pub)]",
          )}
          aria-hidden
        >
          <Check className="size-3" />
        </span>
      )}
      <div>
        <p className="font-serif text-[15.5px] font-semibold text-ink">
          {name}
        </p>
      </div>
    </button>
  );
}

import { ArrowRight } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { isTestnetChainId, useTestnetsEnabled } from "@/lib/preferences";
import { ModeSegmented } from "./ModeSegmented";
import { NetworkCard, type NetworkChoice } from "./NetworkCard";
import { taglineForChainId } from "./network-meta";
import type { DepositMode } from "./DepositSheet";

// Step 1 — pick mode + network. `network` is held by the parent
// (DepositSheet) so the receive step has it on mount. Continue is
// disabled until a network is picked AND mode is public (private has
// no networks yet).

export function DepositPickStep({
  mode,
  onModeChange,
  selectedNetworkId,
  onSelectNetwork,
  onContinue,
}: {
  mode: DepositMode;
  onModeChange: (mode: DepositMode) => void;
  selectedNetworkId: string | null;
  onSelectNetwork: (network: NetworkChoice) => void;
  onContinue: () => void;
}) {
  const [testnetsEnabled] = useTestnetsEnabled();
  const networks = useQuery(api.catalog.networks.list, { enabledOnly: true });
  // Chains where the Pampalo contract suite is deployed. Drives the
  // private-mode network list — only these chains can actually take a
  // shielded inbound. Testnet visibility still gates so the picker
  // matches the rest of the wallet.
  const deployments = useQuery(api.shieldQueue.store.enabledDeployments, {});

  // Build the network choices once Convex resolves. Hide testnets unless
  // the user has opted in via the settings drawer — same gate the assets
  // list uses, so the wallet's "testnet visibility" stays consistent.
  const publicChoices: NetworkChoice[] = (networks ?? [])
    .filter((n) => testnetsEnabled || !isTestnetChainId(n.chainId))
    .map((n) => ({
      id: n._id,
      chainId: n.chainId,
      name: n.name,
      tagline: taglineForChainId(n.chainId),
    }));

  const privateChoices: NetworkChoice[] = (deployments ?? [])
    .filter((d) => testnetsEnabled || !isTestnetChainId(d.chainId))
    .map((d) => ({
      id: d._id,
      chainId: d.chainId,
      name: d.networkName,
      tagline: taglineForChainId(d.chainId),
    }));

  const choices = mode === "public" ? publicChoices : privateChoices;
  const loading =
    mode === "public" ? networks === undefined : deployments === undefined;

  const helperCopy =
    mode === "public"
      ? "Visible on-chain. Anyone can see it."
      : "Shielded the moment it lands. Only you can see it.";

  const continueDisabled = !selectedNetworkId;

  return (
    <div className="flex flex-col gap-5 px-5 pt-2 pb-5 sm:px-6 sm:pt-3 sm:pb-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="font-serif text-[22px] font-bold tracking-[-0.01em] text-ink">
          Choose a network
        </h2>
        <p className="text-[13px] text-ink-mute">
          Deposit funds into your {mode === "public" ? "public" : "shielded"}{" "}
          balance.
        </p>
      </div>

      <div>
        <p className="eyebrow mb-2">Deposit to</p>
        <ModeSegmented value={mode} onChange={onModeChange} />
        <p
          className={cn(
            "mt-2 text-[12px]",
            mode === "public" ? "text-[var(--pub)]" : "text-[var(--priv)]",
          )}
        >
          {helperCopy}
        </p>
      </div>

      <div>
        <p className="eyebrow mb-2">Network</p>

        {loading ? (
          <div className="grid grid-cols-2 gap-3" aria-busy>
            <span className="skel" style={{ height: 132, borderRadius: 16 }} />
            <span className="skel" style={{ height: 132, borderRadius: 16 }} />
          </div>
        ) : choices.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-paper-lo px-5 py-7 text-center">
            <p className="text-[13px] text-ink-mute">
              {mode === "private"
                ? "No private networks available yet. Enable testnets in Account → Settings if you're developing locally."
                : "No networks available. Enable testnets in Account → Settings if you're developing locally."}
            </p>
          </div>
        ) : (
          <div
            className="grid grid-cols-2 gap-3"
            role="radiogroup"
            aria-label="Network"
          >
            {choices.map((n) => (
              <NetworkCard
                key={n.id}
                network={n}
                selected={selectedNetworkId === n.id}
                mode={mode}
                onSelect={() => onSelectNetwork(n)}
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
          "inline-flex items-center justify-center gap-2 h-[50px] rounded-full font-semibold text-[14px]",
          "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          mode === "public"
            ? "bg-[var(--pub)] text-[var(--paper)] hover:bg-[var(--pub-strong,var(--pub))]"
            : "bg-[var(--priv)] text-[var(--paper)] hover:bg-[var(--priv-strong,var(--priv))]",
        )}
      >
        Continue <ArrowRight className="size-4" />
      </button>
    </div>
  );
}

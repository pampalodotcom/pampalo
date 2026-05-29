import { ArrowRight } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { isTestnetChainId, useTestnetsEnabled } from "@/lib/preferences";
import { NetworkCard, type NetworkChoice } from "../deposit/NetworkCard";
import { taglineForChainId } from "../deposit/network-meta";

// Step 1 of the Receive flow — single network picker. No public/private
// mode toggle: Receive is the "share my full identity bundle" flow.
// Sources from `receivableDeployments` (not `enabledDeployments`) so
// forward-declared mainnet rows — Ethereum + Base, where Pampalo
// hasn't shipped yet — appear alongside live testnet deployments. The
// per-row `separateDerivationKey` flag rides through `NetworkChoice`
// so the QR step can pick the matching envelope key.

export function ReceivePickStep({
  selectedNetworkId,
  onSelectNetwork,
  onContinue,
}: {
  selectedNetworkId: string | null;
  onSelectNetwork: (network: NetworkChoice) => void;
  onContinue: () => void;
}) {
  const [testnetsEnabled] = useTestnetsEnabled();
  const deployments = useQuery(
    api.shieldQueue.store.receivableDeployments,
    {},
  );

  const choices: NetworkChoice[] = (deployments ?? [])
    .filter((d) => testnetsEnabled || !isTestnetChainId(d.chainId))
    .map((d) => ({
      id: d._id,
      chainId: d.chainId,
      name: d.networkName,
      tagline: taglineForChainId(d.chainId),
      separateDerivationKey: d.separateDerivationKey,
    }));

  const loading = deployments === undefined;
  const continueDisabled = !selectedNetworkId;

  return (
    <div className="flex flex-col gap-5 px-5 pt-2 pb-5 sm:px-6 sm:pt-3 sm:pb-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="font-serif text-[22px] font-bold tracking-[-0.01em] text-ink">
          Choose a network
        </h2>
        <p className="text-[13px] text-ink-mute">
          We&apos;ll generate a shareable QR with your public and shielded
          receive addresses for that network.
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
              No Pampalo-enabled networks available. Enable testnets in
              Account → Settings if you&apos;re developing locally.
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
                mode="private"
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
          "bg-[var(--priv)] text-[var(--paper)] hover:bg-[var(--priv-strong,var(--priv))]",
        )}
      >
        Continue <ArrowRight className="size-4" />
      </button>
    </div>
  );
}

import { useQuery } from "convex/react";
import { formatUnits } from "ethers";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  ScanEye,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { addressUrl, txUrl } from "@/lib/explorer";
import { useClipboard } from "@/lib/use-clipboard";
import { useDeploymentRoles } from "@/lib/use-deployment-roles";
import { cn } from "@/lib/utils";
import type { NetworkFilter } from "@/components/pampalo/NetworkFilterTabs";
import {
  NetworkChip,
  networkSlugForChainId,
} from "@/components/pampalo/NetworkChip";

// "Vigilant Citizen bot" panel for /sentry (ADR 0016). Surfaces the
// dedicated compliance signer (index 5 off RELAYER_MNEMONIC) that auto-
// contests sanctioned shields: its EOA, gas balance, on-chain role status,
// and last contest. Public material; kept separate from the role-less gas
// relayer pool by design.

function shortAddr(addr: string): string {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtEth(wei: string): string {
  try {
    return `${Number(formatUnits(wei, 18)).toFixed(4)} ETH`;
  } catch {
    return "— ETH";
  }
}

function AddressCell({ address, chainId }: { address: string; chainId: number }) {
  const { copied, copy } = useClipboard();
  const url = addressUrl(chainId, address);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[12.5px] text-ink">
        {shortAddr(address)}
      </span>
      <button
        type="button"
        onClick={() => void copy(address)}
        aria-label={copied ? "Address copied" : "Copy bot address"}
        title={copied ? "Copied" : "Copy address"}
        className={cn(
          "inline-flex size-5 items-center justify-center rounded",
          "text-ink-mute transition-colors hover:bg-paper hover:text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
          copied && "text-[var(--pub)]",
        )}
      >
        {copied ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View bot on block explorer"
          title="View on block explorer"
          className={cn(
            "inline-flex size-5 items-center justify-center rounded",
            "text-ink-mute transition-colors hover:bg-paper hover:text-ink",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint",
          )}
        >
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </span>
  );
}

type SignerRow = {
  chainId: number;
  address: string;
  balanceWei: string;
  lowBalance: boolean;
  lastContestTxHash: string | null;
  lastContestAt: number | null;
};

function ComplianceSignerRow({
  row,
  showChain,
}: {
  row: SignerRow;
  showChain: boolean;
}) {
  // Live on-chain role check for the bot address — the contests only land
  // once it holds VIGILANT_CITIZEN_ROLE.
  const roles = useDeploymentRoles(row.chainId, row.address);
  const slug = networkSlugForChainId(row.chainId);
  const contestUrl = row.lastContestTxHash
    ? txUrl(row.chainId, row.lastContestTxHash)
    : null;

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-2xl border px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between",
        row.lowBalance
          ? "border-[var(--pub-soft-2)] bg-[var(--pub-soft)]"
          : "border-line bg-paper-lo",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <AddressCell address={row.address} chainId={row.chainId} />
        {showChain && slug && <NetworkChip network={slug} />}

        {/* Role status */}
        {roles === null ? (
          <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-mute">
            role…
          </span>
        ) : roles.vigilantCitizen ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--priv-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--priv)]">
            <ShieldCheck className="size-2.5" aria-hidden />
            Vigilant Citizen
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--pub)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white">
            <ShieldX className="size-2.5" aria-hidden />
            Role not granted
          </span>
        )}

        {row.lowBalance && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--pub)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white">
            <AlertTriangle className="size-2.5" aria-hidden />
            Refill
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <span className="font-mono text-[13px] font-semibold text-ink">
          {fmtEth(row.balanceWei)}
        </span>
        <span className="font-mono text-[11px] text-ink-mute">
          {row.lastContestAt === null ? (
            "no contests yet"
          ) : contestUrl ? (
            <a
              href={contestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-ink"
              title="View last contest on block explorer"
            >
              Last contest {timeAgo(row.lastContestAt)}
              <ExternalLink className="size-3 opacity-70" aria-hidden />
            </a>
          ) : (
            `Last contest ${timeAgo(row.lastContestAt)}`
          )}
        </span>
      </div>
    </li>
  );
}

export function ComplianceSignerPanel({ filter }: { filter: NetworkFilter }) {
  const signers = useQuery(api.compliance.store.getComplianceSigner, {});
  if (signers === undefined) return null;
  if (signers.length === 0) return null; // not seeded yet → hide

  const rows =
    filter === "all" ? signers : signers.filter((s) => s.chainId === filter);
  if (rows.length === 0) return null;

  return (
    <div className="mb-4 rounded-3xl card-cream p-4 sm:p-5">
      <header className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--priv-soft)] text-[var(--priv)]"
          aria-hidden
        >
          <ScanEye className="size-4" />
        </span>
        <div>
          <h2 className="font-serif text-[16px] font-bold text-ink">
            Vigilant Citizen bot
          </h2>
          <p className="text-[11.5px] text-ink-mute">
            Automated compliance signer that contests shields from sanctioned
            or blocked addresses during the holding period.
          </p>
        </div>
      </header>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <ComplianceSignerRow
            key={r.chainId}
            row={r}
            showChain={filter === "all"}
          />
        ))}
      </ul>
    </div>
  );
}

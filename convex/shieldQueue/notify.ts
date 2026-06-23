import { formatUnits } from "ethers";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

// ─── Deposit Monitor ─────────────────────────────────────────────────────
//
// Operator-facing email alert fired when a brand-new shield (a "Deposit"
// in user-facing terms) is first indexed into the shield queue. See the
// "Deposit Monitor" term in CONTEXT.md.
//
// Wiring: `store._upsertShieldQueueEntry` schedules this action (via
// `ctx.scheduler.runAfter(0, …)`) only on a genuinely-new, *live* insert
// (unlockTime in the future — backlog/cold-start shields are skipped).
// Because it runs out-of-band, a send failure here can never block or
// fail the indexer. Best-effort by design: there is no retry and no
// "sent" ledger; a lost alert is tolerated (a future SMS-fallback
// redundancy layer is planned).
//
// Entirely gated on operator-set Convex env vars. If any required secret
// is missing or malformed, the send is skipped (logged, never thrown) —
// so local/preview deployments that don't set them send nothing.

// Required env:
//   RESEND_API_KEY            — Resend secret.
//   RESEND_FROM               — verified sender, "addr" or "Name <addr>".
//   DEPOSIT_MONITOR_EMAIL_LIST — comma-separated recipient allowlist.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Block-explorer base URLs, kept in sync with src/lib/explorer.ts (the
// convex/ bundle can't import from src/). Returns null for unknown chains
// — the email then omits the link rather than guessing a URL.
const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  11155111: "https://sepolia.etherscan.io",
  84532: "https://sepolia.basescan.org",
  421614: "https://sepolia.arbiscan.io",
};

function txUrl(chainId: number | undefined, txHash: string): string | null {
  if (chainId === undefined) return null;
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${txHash}` : null;
}

// Minimal RFC-ish email shape check. Deliberately loose: we only want to
// catch obvious junk (empty, missing @, missing dot) so a typo doesn't
// get handed to Resend, not to police every valid-but-weird address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a `RESEND_FROM` value, which may be a bare address or the
 *  "Display Name <addr@host>" form. Returns the original string if the
 *  embedded address is well-formed, else null. */
function validFrom(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = angle ? angle[1].trim() : trimmed;
  return EMAIL_RE.test(addr) ? trimmed : null;
}

/** Parse DEPOSIT_MONITOR_EMAIL_LIST. Mirrors `allowedOrigins()` in
 *  http.ts (split / trim / drop-empty), then validates each entry.
 *
 *  SEND-TO-VALID, by design: a single malformed entry must NOT silence
 *  alerts to the rest of the list, so invalid addresses are dropped and
 *  logged rather than failing the whole send. The caller skips entirely
 *  only when *zero* valid recipients remain. (The strict fail-closed rule
 *  still applies to the secrets — see resolveConfig.) */
function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  for (const e of entries) {
    if (EMAIL_RE.test(e)) valid.push(e);
    else
      console.warn(
        `Deposit Monitor: dropping malformed recipient in DEPOSIT_MONITOR_EMAIL_LIST: "${e}"`,
      );
  }
  return valid;
}

type MonitorConfig = { apiKey: string; from: string; to: string[] };

/** Fail-closed resolution of the operator config. Returns null (and logs
 *  the reason) whenever the monitor should stay silent: any missing/broken
 *  secret, or an empty valid-recipient list. */
function resolveConfig(): MonitorConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("Deposit Monitor: RESEND_API_KEY unset — skipping alert.");
    return null;
  }
  const from = validFrom(process.env.RESEND_FROM);
  if (!from) {
    console.warn(
      "Deposit Monitor: RESEND_FROM unset or malformed — skipping alert.",
    );
    return null;
  }
  const to = parseRecipients(process.env.DEPOSIT_MONITOR_EMAIL_LIST);
  if (to.length === 0) {
    console.warn(
      "Deposit Monitor: DEPOSIT_MONITOR_EMAIL_LIST has no valid recipients — skipping alert.",
    );
    return null;
  }
  return { apiKey, from, to };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const sendDepositAlert = internalAction({
  args: {
    chainId: v.optional(v.number()),
    chainName: v.optional(v.string()),
    shielder: v.string(),
    asset: v.string(),
    amount: v.string(), // raw uint256 decimal string
    assetDecimals: v.optional(v.number()),
    symbol: v.optional(v.string()),
    pendingId: v.string(),
    unlockTime: v.number(), // unix seconds
    queuedTxHash: v.string(),
  },
  handler: async (_ctx, args): Promise<void> => {
    const config = resolveConfig();
    if (!config) return;

    // Decimals: canonical value comes from pampaloAssets.assetDecimals
    // (always present for a supported asset). The ?? 18 fallback only
    // triggers in the rare race where AssetSupported hasn't been indexed
    // yet — flag the amount as possibly wrong when we fall back.
    const decimalsKnown = args.assetDecimals !== undefined;
    const decimals = args.assetDecimals ?? 18;
    let amountStr: string;
    try {
      amountStr = formatUnits(args.amount, decimals);
    } catch {
      amountStr = args.amount; // un-parseable raw value — show as-is
    }
    const assetLabel = args.symbol ? `${amountStr} ${args.symbol}` : amountStr;
    const amountCaveat = decimalsKnown
      ? ""
      : " ⚠️ amount may be incorrect (token decimals unknown — assumed 18)";

    const chainLabel = args.chainName ?? `chain ${args.chainId ?? "?"}`;
    const explorer = txUrl(args.chainId, args.queuedTxHash);
    const unlockIso = new Date(args.unlockTime * 1000).toISOString();

    const subject = `New deposit on ${chainLabel}: ${assetLabel}`;

    const rows: Array<[string, string]> = [
      ["Chain", chainLabel],
      ["Amount", assetLabel + amountCaveat],
      ["Asset", args.symbol ? `${args.symbol} (${args.asset})` : args.asset],
      ["Shielder", args.shielder],
      ["Pending ID", args.pendingId],
      ["Unlocks at", unlockIso],
      ["Queued tx", explorer ?? args.queuedTxHash],
    ];

    const text = rows.map(([k, val]) => `${k}: ${val}`).join("\n");
    const html =
      `<h2>New deposit queued on ${escapeHtml(chainLabel)}</h2>` +
      "<table cellpadding='4' style='font-family:monospace;font-size:13px'>" +
      rows
        .map(([k, val]) => {
          const cell =
            k === "Queued tx" && explorer
              ? `<a href="${escapeHtml(explorer)}">${escapeHtml(explorer)}</a>`
              : escapeHtml(val);
          return `<tr><td><b>${escapeHtml(k)}</b></td><td>${cell}</td></tr>`;
        })
        .join("") +
      "</table>";

    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.from,
          to: config.to,
          subject,
          html,
          text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(
          `Deposit Monitor: Resend returned ${res.status} for pendingId ${args.pendingId}: ${body}`,
        );
      }
    } catch (e) {
      // Best-effort: swallow so a transient Resend/network failure never
      // surfaces as a scheduled-action error.
      console.warn(
        `Deposit Monitor: send failed for pendingId ${args.pendingId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  },
});

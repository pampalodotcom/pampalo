// Standalone Resend send test.
//
// Sends a single test email using the same env vars and REST endpoint as
// the Deposit Monitor (convex/shieldQueue/notify.ts), so a green run here
// proves the Resend key + verified sender + recipient list all work
// end-to-end against the live API.
//
// Reads:
//   RESEND_API_KEY             — Resend secret.
//   RESEND_FROM                — verified sender, "addr" or "Name <addr>".
//   DEPOSIT_MONITOR_EMAIL_LIST — comma-separated recipient allowlist.
//
// Run (loads .env.local via node's --env-file, forwarded by tsx):
//   pnpm tsx --env-file=.env.local scripts/test-resend-email.ts

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Loose RFC-ish check — mirrors notify.ts: catch obvious junk only.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validFrom(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = angle ? angle[1].trim() : trimmed;
  return EMAIL_RE.test(addr) ? trimmed : null;
}

function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  const valid: string[] = [];
  for (const e of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (EMAIL_RE.test(e)) valid.push(e);
    else console.warn(`Dropping malformed recipient: "${e}"`);
  }
  return valid;
}

async function main(): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY unset");

  const from = validFrom(process.env.RESEND_FROM);
  if (!from) throw new Error("RESEND_FROM unset or malformed");

  const to = parseRecipients(process.env.DEPOSIT_MONITOR_EMAIL_LIST);
  if (to.length === 0)
    throw new Error("DEPOSIT_MONITOR_EMAIL_LIST has no valid recipients");

  const stamp = new Date().toISOString();
  console.log(`Sending test email`);
  console.log(`  from: ${from}`);
  console.log(`  to:   ${to.join(", ")}`);

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: `Pampalo Resend test — ${stamp}`,
      text: `This is a test email from scripts/test-resend-email.ts sent at ${stamp}.`,
      html: `<p>This is a test email from <code>scripts/test-resend-email.ts</code> sent at ${stamp}.</p>`,
    }),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${body}`);
  }

  let id = "";
  try {
    id = JSON.parse(body)?.id ?? "";
  } catch {
    /* non-JSON success body — show raw below */
  }
  console.log(`✅ Sent. ${id ? `Resend id: ${id}` : body}`);
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});

// Site-wide footer (FOOTER.md). Two compositions:
//
// - <FooterDesktop /> — three rows on ≥ 768px viewports:
//     1. brand + experimental chip │ Docs + X links
//     2. Terms sentence + ACN       │ © Pampalo Pty Ltd
//     3. Disclaimer box (full-width)
// - <FooterMobile />  — stacked single column on < 768px:
//     1. brand + experimental chip
//     2. disclaimer (short)
//     3. Docs + X links
//     4. legal block (Terms / company / © )
//
// Anything page-level renders this; modals/sheets must not include it
// (it lives below the main route content via __root.tsx, so portal-
// rendered overlays are naturally outside it).

import { Link } from "@tanstack/react-router";
import { ExternalLink, FileText, ShieldAlert } from "lucide-react";
import { BrandLockup } from "./BrandLockup";
import { WarningChip } from "./WarningChip";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

// Pampalo Pty Ltd — Australian Company Number.
const PAMPALO_ACN = "ACN 698 162 999";

const DOCS_URL = "https://docs.pampalo.com";
const X_URL = "https://x.com/pampalodotcom";
const TERMS_URL = "/Pampalo-Terms-of-Service.pdf";

export function Footer() {
  // Hold the footer off the page until auth bootstrap resolves so it doesn't
  // flash behind the PageLoading overlay (or briefly below any route that
  // mounts its own loading state).
  const { state } = useAuth();
  if (state.status === "loading") return null;
  // Footer-at-the-bottom is handled by the sticky-footer column in
  // __root.tsx (main has `flex-1` and absorbs leftover space). All we
  // do here is render the responsive variants. `pt-[6vh]` adds a modest
  // breathing gap above the footer's border so the last card and the
  // footer aren't crowded against each other.
  return (
    <div className="pt-[6vh]">
      <FooterDesktop className="hidden md:block" />
      <FooterMobile className="md:hidden" />
    </div>
  );
}

// ─── Desktop ─────────────────────────────────────────────────────────────

function FooterDesktop({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t border-line pt-7 px-8 pb-8", className)}>
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-7">
        {/* Row 1 — brand + links */}
        <div className="flex flex-wrap items-center justify-between gap-20">
          <div className="flex items-center gap-4">
            <BrandLockup size="sm" />
            <WarningChip>Experimental</WarningChip>
          </div>
          <div className="flex items-center gap-24">
            <FooterInternalLink to="/sentry">
              <ShieldAlert className="size-3 opacity-70" /> Sentry
            </FooterInternalLink>
            <FooterLink href={DOCS_URL} external>
              <FileText className="size-3 opacity-70" /> Docs
            </FooterLink>
            <FooterLink
              href={X_URL}
              external
              aria-label="Pampalo on X (Twitter)"
            >
              <XLogo size={12} /> @pampalodotcom
            </FooterLink>
          </div>
        </div>

        {/* Row 2 — legal */}
        <div className="border-t border-dashed border-line pt-3.5 text-[11.5px] leading-[1.5] text-ink-mute">
          <div className="flex flex-wrap items-baseline justify-between gap-x-20 gap-y-2">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span>
                By using pampalo.com you agree to the{" "}
                <a
                  href={TERMS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-soft underline underline-offset-2 hover:text-ink"
                >
                  Terms &amp; Conditions
                </a>
                .
              </span>
              <span aria-hidden className="text-ink-faint">
                ·
              </span>
              <span>
                Pampalo Pty Ltd is an Australian registered company{" "}
                <span className="font-mono text-ink-faint">{PAMPALO_ACN}</span>
              </span>
            </p>
            <p className="text-ink-faint">
              © {new Date().getFullYear()} Pampalo Pty Ltd
            </p>
          </div>
        </div>

        {/* Row 3 — disclaimer */}
        <Disclaimer />
      </div>
    </footer>
  );
}

// ─── Mobile ──────────────────────────────────────────────────────────────

function FooterMobile({ className }: { className?: string }) {
  return (
    <footer
      className={cn("border-t border-line pt-5 px-[18px] pb-7", className)}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <BrandLockup size="sm" />
          <WarningChip>Experimental</WarningChip>
        </div>

        <Disclaimer short />

        <div className="flex items-center justify-center gap-[22px]">
          <FooterInternalLink to="/sentry">
            <ShieldAlert className="size-3 opacity-70" /> Sentry
          </FooterInternalLink>
          <FooterLink href={DOCS_URL} external>
            <FileText className="size-3 opacity-70" /> Docs
          </FooterLink>
          <FooterLink href={X_URL} external aria-label="Pampalo on X (Twitter)">
            <XLogo size={12} /> @pampalodotcom
          </FooterLink>
        </div>

        <div className="border-t border-dashed border-line pt-4 text-center text-[11.5px] leading-[1.5] text-ink-mute">
          <p>
            By using pampalo.com you agree to the{" "}
            <a
              href={TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Terms &amp; Conditions
            </a>
            .
          </p>
          <p className="mt-1">
            Pampalo Pty Ltd · Australian registered company
          </p>
          <p className="mt-1 text-[10.5px] text-ink-faint">
            © {new Date().getFullYear()} Pampalo Pty Ltd
          </p>
        </div>
      </div>
    </footer>
  );
}

// ─── Sub-bits ────────────────────────────────────────────────────────────

function FooterLink({
  href,
  external,
  children,
  ...rest
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink"
      {...rest}
    >
      {children}
      {external && <ExternalLink className="size-2.5 opacity-50" />}
    </a>
  );
}

// Internal router variant — same visual treatment as FooterLink but
// uses TanStack Router's <Link> so navigation stays client-side
// instead of a hard reload.
function FooterInternalLink({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink"
    >
      {children}
    </Link>
  );
}

function XLogo({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

function Disclaimer({ short = false }: { short?: boolean }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 text-[11px] leading-[1.55]"
      style={{
        background: "var(--color-warn-bg)",
        borderColor: "var(--color-warn-bd)",
        color: "var(--color-warn-fg)",
      }}
    >
      <WarnTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <strong className="font-bold">Pampalo is experimental.</strong>{" "}
        {short ? (
          <>Use only funds you can afford to lose.</>
        ) : (
          <>
            Pampalo is in active development. Privacy guarantees, balances, and
            transactions may change without notice. Use only funds you can
            afford to lose.
          </>
        )}
      </span>
    </div>
  );
}

// Same hand-drawn triangle as WarningChip so the chip and disclaimer
// glyphs stay visually consistent.
function WarnTriangle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 1.8 14.5 13H1.5L8 1.8z"
        fill="#d68a16"
        stroke="#8a5410"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5v3.2"
        stroke="#faf6ea"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.4" r="0.85" fill="#faf6ea" />
    </svg>
  );
}

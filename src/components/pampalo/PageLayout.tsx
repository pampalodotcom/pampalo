// Shared shell for authenticated wallet routes. Owns the app-wide notice
// banners that should be visible on every page, not just /wallet:
//
//   - "Sync Preferences" — the upstream prefs revision is ahead of this
//     device, or local changes haven't pushed. Tap → standalone PRF
//     ceremony, pull-merge-push (syncExplicit). Replaces the old
//     BalanceCard SyncIndicator chip; the reactive revision subscription
//     lives here so every shell route detects upstream changes.
//   - "Finish setting up your account" — compact nudge shown until
//     `mnemonicBackedUpAt` is set in the encrypted prefs blob (ADR 0013).
//     Links to /account, where the louder backup call-to-action card and
//     the export ceremony live. Hidden on /account itself — the loud
//     version is already on screen there.
//
// Sync outranks backup when both apply (it's transient and resolves in
// one tap; backup is patient). X dismisses a banner for the current
// browser session only — backup permanently clears via export, sync via
// actually syncing.

import { useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { useAuth } from "@/lib/auth";
import {
  useIsDirty,
  useLastSeenRevision,
  usePreferences,
  usePrefsLoaded,
} from "@/lib/preferences";
import { syncExplicit } from "@/lib/preferences-sync";

function useSessionDismiss(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return (
        typeof window !== "undefined" &&
        window.sessionStorage.getItem(key) === "1"
      );
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* private browsing / quota — in-memory dismiss still works */
    }
    setDismissed(true);
  };
  return [dismissed, dismiss];
}

export function PageLayout({ children }: { children: React.ReactNode }) {
  // `relative` so the banners can float over the BeachScene hero instead
  // of stacking a flow block above it (which reads as a sudden cream
  // band before the sky). Content never shifts when a banner appears.
  return (
    <main className="phone-shell relative flex flex-1 flex-col">
      <NoticeBanners />
      {children}
    </main>
  );
}

function NoticeBanners() {
  const auth = useAuth();
  const pathname = useLocation({ select: (l) => l.pathname });
  const sessionToken =
    auth.state.status === "authenticated" ? auth.state.sessionToken : null;

  const upstream = useQuery(
    api.preferences.mutations.getPreferencesRevision,
    sessionToken ? { sessionToken } : "skip",
  );
  const local = useLastSeenRevision();
  const dirty = useIsDirty();
  const prefs = usePreferences();
  const prefsLoaded = usePrefsLoaded();

  const [syncDismissed, dismissSync] = useSessionDismiss(
    "pampalo:banner-dismissed:sync",
  );
  const [backupDismissed, dismissBackup] = useSessionDismiss(
    "pampalo:banner-dismissed:backup",
  );
  const [syncing, setSyncing] = useState(false);

  if (!sessionToken) return null;

  const upstreamAhead =
    upstream !== undefined &&
    upstream !== null &&
    (local === null || upstream > local);
  const syncVisible = !syncDismissed && (dirty || upstreamAhead || syncing);
  const backupVisible =
    !syncVisible &&
    !backupDismissed &&
    prefsLoaded &&
    prefs.mnemonicBackedUpAt === undefined &&
    pathname !== "/account";

  async function onSync() {
    setSyncing(true);
    try {
      await syncExplicit();
      toast("Preferences synced");
    } catch (e) {
      console.warn("preferences sync failed", e);
      toast.error("Sync failed — try again");
    } finally {
      setSyncing(false);
    }
  }

  if (syncVisible) {
    return (
      <BannerShell>
        <div className="rise-in flex items-center gap-3 rounded-2xl border border-line card-cream px-4 py-3 shadow">
          {syncing ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-ink-soft" />
          ) : (
            <RefreshCw className="size-4 shrink-0 text-ink-soft" />
          )}
          <p className="flex-1 text-[13px] font-medium leading-snug text-ink">
            {upstreamAhead
              ? "Preferences changed on another device."
              : "You have preference changes that haven’t synced."}
          </p>
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={syncing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:bg-paper-lo disabled:opacity-60"
          >
            {syncing ? "Syncing…" : "Sync"}
          </button>
          <DismissButton onDismiss={dismissSync} />
        </div>
      </BannerShell>
    );
  }

  if (backupVisible) {
    // Compact nudge — the loud version with the actual export CTA lives
    // on /account (see AccountPage), so this just gets the user there.
    return (
      <BannerShell>
        <div className="rise-in ml-auto flex w-fit items-center gap-2 rounded-full border border-line card-cream py-1.5 pl-3.5 pr-1.5 shadow">
          <KeyRound className="size-3.5 shrink-0 text-ink-soft" />
          <Link
            to="/account"
            className="text-[12.5px] font-semibold text-ink transition-colors hover:text-ink-soft"
          >
            Finish setting up your account
          </Link>
          <DismissButton onDismiss={dismissBackup} small />
        </div>
      </BannerShell>
    );
  }

  return null;
}

// Floats over the BeachScene hero, below the per-route header row
// (logo / theme toggle sit at top-6 with h-8, so top-16 clears them)
// and across the horizon line. Width + horizontal padding mirror the
// wallet content column (max-w-3xl px-[8vw] sm:px-4 lg:max-w-4xl) so
// banner edges line up with the cards below.
function BannerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 top-16 z-20">
      <div className="mx-auto w-full max-w-3xl px-[8vw] sm:px-4 lg:max-w-4xl">
        {children}
      </div>
    </div>
  );
}

function DismissButton({
  onDismiss,
  small,
}: {
  onDismiss: () => void;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss for this session"
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-paper-lo hover:text-ink ${
        small ? "size-6" : "size-7"
      }`}
    >
      <X className={small ? "size-3.5" : "size-4"} />
    </button>
  );
}

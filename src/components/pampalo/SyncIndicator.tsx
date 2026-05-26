// Top-right indicator on the BalanceCard. Visible only when the server
// has a higher preferences revision than this device's last-seen value.
// Tap → runs an explicit PRF ceremony, pulls upstream prefs, pushes any
// local diff. See CLIENT_SIDE_FIRST.md.

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { useIsDirty, useLastSeenRevision } from "@/lib/preferences";
import { syncExplicit } from "@/lib/preferences-sync";

export function SyncIndicator() {
  const auth = useAuth();
  const sessionToken =
    auth.state.status === "authenticated" ? auth.state.sessionToken : null;

  const upstream = useQuery(
    api.preferences.mutations.getPreferencesRevision,
    sessionToken ? { sessionToken } : "skip",
  );
  const local = useLastSeenRevision();
  const dirty = useIsDirty();
  const [syncing, setSyncing] = useState(false);

  if (!sessionToken) return null;
  if (upstream === undefined) return null; // initial load

  // Two reasons to surface the indicator:
  //   - local has unpushed changes (`dirty`), or
  //   - upstream has bumped past what we last applied.
  // Both resolve via the same `syncExplicit()` call (pull-then-push).
  const upstreamAhead =
    upstream !== null && (local === null || upstream > local);
  const hasWork = dirty || upstreamAhead;
  if (!hasWork && !syncing) return null;

  const onTap = async () => {
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
  };

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={syncing}
      aria-label="Sync preferences from another device"
      className="inline-flex items-center gap-1.5 rounded-full bg-paper-lo border border-line px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink hover:bg-paper disabled:opacity-60"
    >
      {syncing ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <RefreshCw className="size-3" />
      )}
      {syncing ? "Syncing…" : "Sync Preferences"}
    </button>
  );
}

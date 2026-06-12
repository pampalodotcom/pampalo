import { useCallback, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// Privacy-gate for the self-broadcast fallback (TRANSFERS.md §6.4). When
// the gas-sponsoring relayer can't broadcast, we must NOT silently sign
// from the user's own wallet — that publicly links their EVM address. This
// hook bridges an imperative `await confirm()` to a styled overlay so the
// broadcast helper can pause for an explicit yes/no. Defaults to Cancel.

function shortAddr(addr: string): string {
  if (!/^0x[0-9a-fA-F]{6,}$/.test(addr)) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}

export function useSelfBroadcastFallback(evmAddress: string): {
  confirm: () => Promise<boolean>;
  element: React.ReactNode;
} {
  // Wrap the resolver in an object so React's setState doesn't mistake the
  // stored function for an updater callback.
  const [pending, setPending] = useState<{
    resolve: (ok: boolean) => void;
  } | null>(null);

  const confirm = useCallback(
    () => new Promise<boolean>((resolve) => setPending({ resolve })),
    [],
  );

  const decide = useCallback((ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }, []);

  const element = pending ? (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="alertdialog"
      aria-modal="true"
      aria-label="Gas sponsor unavailable"
    >
      <div className="w-full max-w-[420px] rounded-3xl card-cream p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--pub-soft)] text-[var(--pub)]"
            aria-hidden
          >
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="font-serif text-[16px] font-bold text-ink">
              Gas sponsor unavailable
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
              Pampalo&apos;s gas sponsor can&apos;t broadcast this right now.
              Continuing will send from your own wallet and publicly link your
              address{" "}
              <span className="font-mono text-ink">{shortAddr(evmAddress)}</span>{" "}
              to this transaction.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => decide(true)}
            className={cn(
              "inline-flex h-[46px] w-full items-center justify-center rounded-full px-5",
              "text-[14px] font-bold text-white shadow-sm",
              "bg-gradient-to-b from-[var(--pub-hi)] to-[var(--pub)]",
            )}
          >
            Send from my wallet
          </button>
          <button
            type="button"
            onClick={() => decide(false)}
            className={cn(
              "inline-flex h-[42px] w-full items-center justify-center rounded-full",
              "border border-line bg-transparent px-5 text-[13.5px] font-semibold text-ink",
              "transition-colors hover:bg-paper-lo",
            )}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, element };
}

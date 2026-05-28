import { useCallback, useEffect, useRef, useState } from "react";

// Small clipboard wrapper. Returns the latest "copied" state so the UI
// can swap the Copy button label to "Copied" for a beat. The timeout
// is cleared on unmount so we don't setState on a torn-down component.

export function useClipboard(resetMs = 1500): {
  copied: boolean;
  copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // No clipboard permission / insecure context — silently swallow.
        // Caller can wrap this hook with a toast if they want feedback.
        return;
      }
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return { copied, copy };
}

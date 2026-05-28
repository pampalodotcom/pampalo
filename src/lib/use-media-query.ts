import { useEffect, useState } from "react";

// Tiny matchMedia hook. Default `false` so SSR/first-paint matches the
// "mobile first" assumption — the desktop branch lights up after hydrate
// rather than during initial render, which keeps the bottom sheet from
// flashing as a dialog on a desktop browser.

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

// Tailwind's `sm` breakpoint (640px). Used to swap a bottom Sheet (mobile)
// for a centered Dialog (desktop) in modals that render in both contexts.
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 640px)");
}

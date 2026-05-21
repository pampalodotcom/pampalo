import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
};

const STORAGE_KEY = "pampalo:theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPersistedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function applyHtmlAttr(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

// Sky-blue tint for the browser chrome (iOS Safari URL bar / Android
// Chrome status bar). Values mirror BeachScene's PAL.{light,dark}.clear
// so the chrome blends into the scene's sky band at the top of the
// wallet shell. The unconditional <meta name="theme-color"> tag is
// updated; any `media`-qualified variants (set in __root.tsx for the
// pre-JS OS-pref fallback) are left alone — they're not used once we
// have a live theme to follow.
const SKY_COLOR: Record<Theme, string> = {
  light: "#a3d9ff",
  dark: "#0a1830",
};
function applyThemeColorMeta(theme: Theme): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  meta?.setAttribute("content", SKY_COLOR[theme]);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Default to "light" on SSR / first paint; sync from localStorage on mount.
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const persisted = readPersistedTheme();
    const resolved = persisted ?? "light";
    if (persisted) setThemeState(persisted);
    applyHtmlAttr(resolved);
    applyThemeColorMeta(resolved);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyHtmlAttr(t);
    applyThemeColorMeta(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

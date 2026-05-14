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

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Default to "light" on SSR / first paint; sync from localStorage on mount.
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const persisted = readPersistedTheme();
    if (persisted) setThemeState(persisted);
    applyHtmlAttr(persisted ?? "light");
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyHtmlAttr(t);
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

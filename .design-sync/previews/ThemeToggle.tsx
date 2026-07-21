import { ThemeToggle, StatusDot } from "pampalo";

// Reads the active theme from ThemeProvider (the preview harness supplies
// it) and renders a Day / Night pill. Shown at rest — toggling is an
// interaction the screenshot can't capture.

export const Default = () => <ThemeToggle />;

// As it sits in the app header: signed-in status on the left, toggle right.
export const InHeaderRow = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 24,
      width: 420,
      padding: "10px 16px",
      borderRadius: 14,
      border: "1px solid var(--color-line)",
      background: "var(--color-paper)",
    }}
  >
    <StatusDot label="Signed in" />
    <ThemeToggle />
  </div>
);

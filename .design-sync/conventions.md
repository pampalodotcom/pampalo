# Building with the Pampalo design system

Pampalo is a private-payments wallet. The visual language is a warm beach
postcard: cream paper surfaces, deep-ink text, a coral accent for **public**
money and green for **private/shielded** money. Serif display numerals
(Fraunces), Inter for UI text, JetBrains Mono for amounts and addresses.

## Setup

Wrap every screen in `ThemeProvider` (exported from the bundle). It supplies
the theme context that `ThemeToggle` and the token set rely on; dark mode is
applied by setting `data-theme="dark"` on `<html>`, which ThemeProvider
manages. Without it, `ThemeToggle` throws and surfaces render light-only.

Toasts: render one `<Toaster />` near the root and fire notifications with
the bundled `toast` export (`toast.success("Shield confirmed")`). Both come
from this bundle — do not import a separate sonner copy.

## Styling idiom

Components style themselves; your layout glue should use the shipped
Tailwind classes. The brand vocabulary (all present in the shipped CSS):

- Surfaces: `bg-paper` (page), `bg-paper-lo` (inset wells), `border-line`
- Text: `text-ink`, `text-ink-soft`, `text-ink-mute`, `text-ink-faint`,
  `text-paper` (on dark/accent fills)
- Accents: `bg-accent` (coral, public actions), `bg-shield` (green,
  private), warnings via `bg-warn-bg` + `border-warn-bd` + `text-warn-fg`
- Type: `font-serif` (Fraunces display numerals), `font-sans` (Inter),
  `font-mono` (JetBrains Mono for amounts/addresses); pills are
  `rounded-full`, cards `rounded-xl`
- Standard Tailwind layout utilities (`flex`, `gap-*`, `p-*`, `grid`, …)
  are available as used throughout the app.

The full token set is broader than the utility list: every color exists as
a CSS custom property (`--color-paper`, `--color-ink`, `--color-accent`,
`--color-accent-d`, `--color-pub`, `--color-priv`, `--color-sea`,
`--color-sun`, `--color-shield`, `--color-line`, …). If a utility class you
want isn't listed above, don't guess a class name — use an inline style
with the token: `style={{ background: "var(--color-pub)" }}`. Coral/`pub`
always means public funds; green/`priv`/`shield` always means private —
never swap them.

## Where the truth lives

Read `styles.css` and its import `_ds_bundle.css` for the real tokens and
compiled classes. Each component ships `<Name>.d.ts` (its exact props) and
`<Name>.prompt.md` (usage notes) — check `AssetRow`, `BalanceCard`, and
`GasTierPicker` before composing them; their props are data objects, not
free-form children.

## Idiomatic example

```tsx
import { ThemeProvider, BalanceCard, AssetRow, PrimaryButton } from "pampalo";

const eth = {
  symbol: "ETH", name: "Ethereum", decimals: 18, priceUsd: 3184.2,
  publicWei: 750000000000000000n, privateWei: 1250000000000000000n,
  chainIds: [1, 8453],
};

export default function Wallet() {
  return (
    <ThemeProvider>
      <main className="bg-paper min-h-screen p-6 flex flex-col gap-6">
        <div style={{ width: 640 }} className="flex flex-col gap-4">
          <BalanceCard totalUsd={12483.52} publicUsd={2483.52} privateUsd={10000} />
          <AssetRow asset={eth} shieldable onMove={() => {}} />
          <div style={{ width: 360 }}>
            <PrimaryButton>Confirm &amp; Send</PrimaryButton>
          </div>
        </div>
      </main>
    </ThemeProvider>
  );
}
```

Full-width components (`PrimaryButton`, `SecondaryButton`, `BalanceCard`,
`AssetRow`, the Deposit/Receive/Send buttons, `SplitBar`) are `w-full` or
have no intrinsic width — always place them in a width-constrained wrapper.

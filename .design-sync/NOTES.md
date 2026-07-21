# design-sync notes — pampalo

## Re-sync risks (watch-list)

- `.design-sync/entry.tsx` is a hand-maintained export list: a NEW component
  added under `src/components/` is invisible to the sync until it's added to
  the entry AND `componentSrcMap`. Check for new files on every re-sync.
- The asset shim inlines 6 hard-coded `public/` files
  (make-asset-shim.mjs ASSETS). A new token/network logo referenced by
  absolute URL needs adding there or it 404s in designs.
- `cfg.buildCmd` must run before the converter (Tailwind compile → asset
  shim → tsc declarations → types/index.d.ts). Skipping it re-syncs against
  stale CSS/types. On a fresh clone `.ds-sync/` must be re-staged and its
  deps (`esbuild ts-morph @types/react playwright@1.57.0 @tailwindcss/cli@4`)
  reinstalled; playwright 1.57.0 matches the cached chromium-1200 on this
  machine.
- `package.json` `"types": "types/index.d.ts"` points at a gitignored
  generated tree — on a fresh clone it dangles until buildCmd runs. Nothing
  in the app resolves it, but don't "fix" it by deleting the field.
- TypingAnimation cells are capture-timing sensitive (graded with a caveat):
  a slower machine could catch mid-typing frames — re-grade, don't rework.
- Only partially verified: dark theme (`data-theme="dark"`) was never
  screenshotted; all grading is light-mode.
- Google Fonts load remotely at render time — offline renders fall back.


- This is an app repo, not a packaged DS. The bundle is built from
  `.design-sync/entry.tsx` (custom `--entry`), which re-exports only the
  presentational components. App-wired components are deliberately excluded
  (they need Convex/router/auth at module or render time): AccountModal,
  Footer, MonthlyCapCard, PageLayout, PreviousDeploymentBanner,
  PrivateSwapPanel, RetiredNotesHistory, RetiredWithdrawSheet, SendModal,
  SwapModal, SelfBroadcastFallback, DepositSheet, DepositPickStep,
  ReceiveSheet, ReceivePickStep, ReceiveQRStep (calls useAuth), SendSheet,
  SendComposeStep, SendPickStep, SendReviewStep, sentry/* (6 panels),
  BoothSendBar, shield/* (3 sheets).
- The repo has no `.d.ts` output (`noEmit: true`), so prop extraction needs a
  generated declarations tree: cfg.buildCmd runs
  `npx tsc -p .design-sync/tsconfig.dts.json` (emits `types/` from the entry's
  import graph, gitignored) and regenerates `types/index.d.ts`;
  `package.json` carries `"types": "types/index.d.ts"` so findTypesRoot picks
  it up. Without this every `<Name>Props` collapses to `[key: string]: unknown`.
  The tsc emit prints one TS2308 warning (`shortAddress` exported by both
  AccountAvatar and AddressPill via `export *`) — harmless, exits 0.
  Side effect: the types entry surfaces every PascalCase export, so shadcn
  compound subparts (CardHeader, DialogTrigger, …) and ThemeProvider are
  nulled in componentSrcMap to stay family-level cards (34 nulls).
- CSS is Tailwind v4 (CSS-first, `@tailwindcss/vite` — no CLI in repo deps).
  We compile it with `@tailwindcss/cli@4` installed in `.ds-sync/`:
  `.ds-sync/node_modules/.bin/tailwindcss -i src/styles.css -o .design-sync/.cache/compiled.css`
  (= cfg.buildCmd; run before every converter build). Tailwind auto-scans the
  repo from cwd, so utilities used in `.design-sync/previews/*.tsx` are
  picked up — run the compile AFTER authoring previews.
- Fonts are remote Google Fonts (Fraunces, Inter, JetBrains Mono) via
  `@import url(...)` kept at the top of the compiled CSS → `[FONT_REMOTE]`
  is expected, no font files to ship.
- Brand/token images are referenced by absolute runtime URLs into `public/`
  (`/pampalo-circular.svg`, `/eth-logo.png`, `/usdc-logo.png`,
  `/audd-logo.png`, `/link-logo.png`, `/base-logo.svg`). These don't resolve
  inside preview cards or rendered designs — watch AssetMark, NetworkChip,
  NetworkLogo, BrandLockup, PageLoading, DepositReceiveStep at render check.
- `cfg.provider` = `ThemeProvider` (from `src/lib/theme.tsx`, re-exported in
  the entry) — self-contained localStorage theme context; `ThemeToggle`
  throws without it.
- ui primitives are regrouped to "Primitives" via `.design-sync/docs-stubs/*.md`
  frontmatter stubs (cfg.docsMap).

## Preview-authoring learnings (wave 1, 2026-07-14)

- Previews import from `"pampalo"`; lucide-react OK; `React.ReactNode` prop
  types need an explicit `import * as React from "react"`.
- Layout glue: inline `style={{width: N}}` — the pampalo CTA buttons,
  BalanceCard, SplitBar, AssetRow are `w-full`/no-intrinsic-width and need a
  fixed-width wrapper (360 for buttons, 640–760 for rows/cards). Previews ARE
  Tailwind-scanned (`@source "./previews"` in tw-entry.css), so standard
  utilities compile, but new arbitrary-value classes require the buildCmd
  Tailwind recompile before they exist.
- Static-open overlays: `<Dialog open>` / `<Sheet open>` render portal
  content without interaction. Tooltip: `TooltipProvider > Tooltip open`,
  pad the trigger's tooltip side (~72px). Toaster (sonner): fire
  `toast.*({duration: Infinity})` in a `useEffect`; `<Toaster expand />`.
- TypingAnimation: capture lands ~0.45s after mount — use
  `startOnView={false}`, `duration`≤10ms/char, `loop` + long `pauseDelay`;
  pass `leading-snug` (default is hero-scale `leading-20`).
- AnimatedShinyText default grey is off-brand — app always overrides with
  `text-ink` (see BalanceCard sync chip); previews should too.
- Micro-chips (NetworkChip, StatusDot, Sun/MoonIcon at 12px default) are
  near-invisible alone — compose labeled rows with explicit size/color
  (`var(--color-pub)` / `var(--color-priv)`).
- GasTierPicker: `gasPriceWei` is a decimal-string of wei, `gasUnits` bigint;
  omit `open`/`onToggle` for the inline chrome. QRCanvas prop is `value`.
  NetworkCard needs `mode` even when unselected; taglines from
  `deposit/network-meta.ts`.
- Editing `cfg.overrides.<Name>.viewport` re-keys grade stamps →
  preview-rebuild exits `[CONFIG_STALE]` until a full package-build re-stamps.
  Set viewports BEFORE a wave, or expect a full rebuild mid-wave.
- Known render warns (triaged legitimate):
  - `[RENDER_THIN] Toaster: rendered height is 0px` — sonner's toast list is
    a fixed-position `<ol>` that measures 0px by design; the toasts
    themselves render fine (screenshot-verified). Benign, will recur.
  - `[FONT_REMOTE]` Inter/JetBrains Mono/Fraunces — expected (Google Fonts
    @import), no files to ship.
  - Review-sheet cells all show a tall cream canvas block below content
    (harness cell chrome, not a defect).
  AssetMark fallback "•" glyph reads as a near-invisible dot (component
  design nit, not a preview bug).
- Skipped as interaction-only (by design): hover/focus states everywhere,
  AddressWell "Copied" state (clipboard-gated), BalanceCard `staleSync`
  nudge (TypingAnimation starts empty), ThemeToggle night state, Sheet drag.

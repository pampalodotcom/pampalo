# User-facing copy audit

A review of **every string an end-user sees in the Pampalo web app**, with
proposed friendlier wording. The trigger for this audit was a real leak: the
private-swap screen tells users _"surplus is forfeited (ADR 0020)"_ — an
internal architecture-decision-record reference that should never reach a UI.

This document is the proposal. Nothing here is wired into the code yet — each
row gives the file, line, the exact current string, and a suggested
replacement so the changes can be reviewed and applied in batches.

**Scope:** `src/routes/**` and `src/components/pampalo/**` (JSX text, button
labels, toasts, placeholders, aria-labels, titles) plus the human-message
helpers in `src/lib/` (`auth-errors.ts`, `broadcast-error.ts`). Code comments,
console logs, and developer-only debug disclosures are excluded.

**Audience note:** the `/sentry` surfaces (`src/components/pampalo/sentry/**`)
are operator tools, not end-user screens. Jargon there is lower severity, so
those findings are collected separately in the last section.

---

## The one systemic problem: inconsistent privacy vocabulary

The single biggest issue is not any one string — it's that **the core
public/private concept is named four different ways** depending on which
screen you're on. A new user cannot tell that these all refer to the same
thing:

| Concept | Plain label (good, already used) | Jargon variants leaking elsewhere |
|---|---|---|
| The private balance / private mode | **Private** (toggle, `ModeSegmented`, balance chips) | "Shielded", "shield", "shielded balance", "shielded note", "note" |
| Making funds private (deposit side) | — | "shield", "shielding" |
| Making funds public (withdraw side) | — | "unshield", "unshielding" |
| The private receiving address | **Private address** (`DepositReceiveStep`) | "Poseidon", "Poseidon address", "Poseidon2 (ZK identity)", "Poseidon identifier" |
| The note-encryption key | **Encryption key** (proposed) | "Envelope", "Envelope key", "Note encryption (secp256k1 public key)" |
| The public address | **Ethereum** (`DepositReceiveStep`) | "EVM", "EVM address" |
| Refreshing balances | "Sync" / "Refresh" | "resync", "Sync notes from Convex", "Sync" as a proper noun the recipient must know |

**Recommendation — standardize on this user-facing glossary and use it
everywhere:**

- **Private** / **Private balance** — never "shielded".
- **Make private** / **Make public** — for the shield/unshield actions
  (keep "shield/unshield" only in code, comments, and the contract layer).
- **Private address** — never "Poseidon".
- **Encryption key** — never "Envelope".
- **Public address** (or **Ethereum**, pick one and keep it) — never "EVM".
- **Sync / Refresh** — a verb, never a feature-name the user is assumed to
  know. When telling a _recipient_ to update, say "refresh their Pampalo
  wallet", not "Sync".

Everything in Tier 2 below is an instance of this one fix.

---

## Tier 1 — Internal references that must never reach a user

These leak implementation detail, internal codenames, the backend product
name, or developer-only instructions. Highest priority.

| Location | Current | Proposed |
|---|---|---|
| `src/components/pampalo/PrivateSwapPanel.tsx:580` | `surplus is forfeited (ADR 0020)` | `Anything above this stays in the pool.` |
| `src/components/pampalo/BalanceCard.tsx:177` (aria-label) | `Sync notes from Convex` / `Syncing notes` | `Sync balances` / `Syncing balances` |
| `src/components/pampalo/shield/UnshieldConfirmSheet.tsx:581` | `First run on a fresh tab pays the bb.js WASM warm-up (a few seconds).` | `The first time can take a few seconds while the prover loads.` |
| `src/components/pampalo/shield/ShieldConfirmSheet.tsx:247` | `ETH/asset address mismatch detected. Refusing to shield to avoid a wrong-decimals broadcast.` | `Something looks off with this asset, so we've stopped to keep your funds safe. Reload and try again.` |
| `src/routes/share.tsx:299` | `The page expects at least an \`evm\` query parameter, e.g. \`/share?evm=0xabc…\`.` | `This link doesn't include an address to show. Ask the sender for a new link.` |
| `src/components/pampalo/deposit/DepositPickStep.tsx:104` (and 2nd empty-state) | `…Enable testnets in Account → Settings if you're developing locally.` | Drop the dev clause: `No networks available yet. If you're testing, enable testnets in Account → Settings.` |
| `src/components/pampalo/receive/ReceivePickStep.tsx:64` | `…Enable testnets in Account → Settings if you're developing locally.` | same as above |
| `src/components/pampalo/shield/UnshieldConfirmSheet.tsx:439` | `…on chain ${chainId}` (renders "chain 84532") | Use the resolved network name; fall back to `this network`, never `chain <number>`. |
| `src/components/pampalo/shield/ShieldConfirmSheet.tsx:498` | `…on chain ${chainId}` | same — use network name |
| `src/routes/sentry.tsx:842`, `849`, `916` | `chain ${chainId}` / `unknown` | `Unknown network` |

---

## Tier 2 — Cryptographic jargon in labels, hints, and body copy

The privacy-vocabulary fix from the top of the doc, applied string by string.

### Address & key labels

| Location | Current | Proposed |
|---|---|---|
| `src/routes/account.tsx:195` | label `Envelope`, hint `Note encryption (secp256k1 public key)` | label `Encryption key`, hint `Used to encrypt your private transfers` |
| `src/routes/account.tsx:200` | label `Private`, hint `Poseidon2 (ZK identity)` | label `Private address`, hint `Your address for private transfers` |
| `src/routes/share.tsx:228` | label `Envelope`, hint `Note encryption (secp256k1 public key)` | label `Encryption key`, hint `Used to send this person private transfers` |
| `src/routes/share.tsx:236` | label `Private`, hint `Poseidon2 (ZK identity)` | label `Private address`, hint `Their address for private transfers` |
| `src/components/pampalo/receive/ReceiveQRStep.tsx:236-238` | `EVM` / `Envelope` / `Poseidon` | `Ethereum` / `Encryption key` / `Private address` |
| `src/components/pampalo/deposit/DepositReceiveStep.tsx:199` | `Envelope` | `Encryption key` |
| `src/components/pampalo/send/SendComposeStep.tsx:505-506` | label `Poseidon address`, hint `Spend / stealth address (0x + 64 hex)` | label `Private address`, hint `Their private receiving address (0x + 64 characters)` |
| `src/components/pampalo/send/SendComposeStep.tsx:513-514` | label `Envelope key`, hint `Note encryption key (0x04 + 128 hex, uncompressed secp)` | label `Encryption key`, hint `Encrypts the payment to them (0x04 + 128 characters)` |
| `src/components/pampalo/send/SendReviewStep.tsx:725` | `Poseidon · {key}` | `Private address · {key}` |
| `src/components/pampalo/send/SendReviewStep.tsx:728` | `Envelope · {key}` | `Encryption key · {key}` |
| `src/components/pampalo/RecoverAccount.tsx:269,273,276` | `Show envelope key and Poseidon identifier` / `Envelope key` / `Poseidon identifier` | `Show encryption key and private address` / `Encryption key` / `Private address` |
| `src/components/pampalo/shield/ShieldConfirmSheet.tsx:511` | `Recipient (Your {network} Poseidon Address)` | `Recipient (your private {network} address)` |

### "Shielded" → "Private" and "note" → "balance"

| Location | Current | Proposed |
|---|---|---|
| `src/routes/wallet.tsx:580` | `Each balance is split between what's visible on-chain and what's shielded.` | `Each balance is split between what's public and what's private.` |
| `src/routes/wallet.tsx:738` | `Synced ${n} note(s).` | `Sync complete — ${n} update(s).` |
| `src/routes/wallet.tsx:265,290` | `Couldn't resolve this shield yet — tap Sync and try again.` | `We couldn't find that private transfer yet — tap Sync and try again.` |
| `src/components/pampalo/send/SendPickStep.tsx:65` | `Spending from your shielded balance.` | `Spending from your private balance.` |
| `src/components/pampalo/send/SendPickStep.tsx:104` | `Shielded — only the recipient can decrypt it.` | `Private — only the person you send to can see it.` |
| `src/components/pampalo/send/SendPickStep.tsx:108` | `Visible on-chain. Anyone can see it.` | `Visible on the public blockchain — anyone can see it.` |
| `src/components/pampalo/send/SendPickStep.tsx:122` | `No shielded-send networks available yet.` | `No networks support private sends yet.` |
| `src/components/pampalo/send/SendReviewStep.tsx:705` | `Shielded balance` / `Public balance` | `Private balance` / `Public balance` |
| `src/components/pampalo/send/SendReviewStep.tsx:747` | `Shielded — only the recipient can decrypt this. Amount and recipient stay hidden on-chain.` | `Private — only the recipient can see this. The amount and who you sent to stay hidden.` |
| `src/components/pampalo/send/SendReviewStep.tsx:751` | `This transfer is visible on-chain and can't be reversed.` | `This transfer is public and can't be reversed.` |
| `src/components/pampalo/send/SendReviewStep.tsx:396` | `No spendable shielded note covers this amount yet. Try a smaller amount, or shield more first.` | `Your private balance isn't large enough for this amount. Try a smaller amount, or add more to your private balance first.` |
| `src/components/pampalo/deposit/DepositPickStep.tsx:64` | `Shielded the moment it lands. Only you can see it.` | `Private the moment it lands. Only you can see it.` |
| `src/components/pampalo/deposit/DepositPickStep.tsx:63,76` | `Visible on-chain…` / `…into your shielded balance.` | `Visible on the public blockchain…` / `…into your private balance.` |
| `src/components/pampalo/deposit/DepositReceiveStep.tsx:133,188` | `…in your shielded balance…` / `{network} · Shielded` | `…in your private balance…` / `{network} · Private` |
| `src/components/pampalo/AssetRow.tsx:360` | `Shielding… on-chain` / `Unshielding… on-chain` | `Making private…` / `Making public…` |
| `src/components/pampalo/MonthlyCapCard.tsx:105,111` | `Shielded this month` / `Unshielded this month` | `Made private this month` / `Made public this month` |
| `src/components/pampalo/PrivateSwapPanel.tsx:481` | `Submitted — syncing your private notes as they're decrypted. You can keep this open.` | `Submitted — updating your private balance. You can keep this open.` |
| `src/components/pampalo/PrivateSwapPanel.tsx:592` | `No single note covers this amount yet (multi-note swaps coming soon).` | `No single private balance is large enough yet (combining balances is coming soon).` |
| `src/components/pampalo/shield/UnshieldConfirmSheet.tsx:209` | `No spendable shielded note covers this amount. Try a smaller drag or shield more first.` | `None of your private balances is large enough for this amount. Try a smaller amount, or add more first.` |
| `src/components/pampalo/shield/ShieldConfirmSheet.tsx:496` | `Moving from public balance into a private note on {chain}.` | `Moving from your public balance into your private balance on {network}.` |
| `src/components/pampalo/RetiredNotesHistory.tsx:253` | `Read-only — this contract was redeployed with a circuit change, so these notes can't be withdrawn here.` | `Read-only — this older contract isn't compatible with the current one, so these balances can't be withdrawn here.` |
| `src/components/pampalo/RetiredWithdrawSheet.tsx:104` | `Rebuilding the previous contract's tree — try again shortly.` | `Still loading your previous balances — try again shortly.` |
| `src/components/pampalo/RetiredWithdrawSheet.tsx:242` | `…· {n} notes (one tx each)` | `…· {n} withdrawals` |
| `src/components/pampalo/PreviousDeploymentBanner.tsx:85` | `You have notes in a previous Pampalo deployment` | `You have funds in a previous Pampalo contract` |

### "Merkle tree" / "proof" / "broadcast" / "mined" in flow status

| Location | Current | Proposed |
|---|---|---|
| `src/components/pampalo/send/SendReviewStep.tsx:390` | `Merkle tree still loading` | `Still getting things ready — try again in a moment.` |
| `src/components/pampalo/shield/UnshieldConfirmSheet.tsx:204` | `Merkle tree still loading — try again in a moment.` | `Still preparing your private balance — try again in a moment.` |
| `src/components/pampalo/send/SendReviewStep.tsx:626-631` | `Preparing proof…` / `Awaiting passkey…` / `Broadcasting…` | `Getting things ready…` / `Confirm with your passkey…` / `Sending…` |
| `src/components/pampalo/send/SendReviewStep.tsx:851` | `Transfer mined.` | `Transfer complete.` |
| `src/components/pampalo/SendModal.tsx:1016` | `Mined - waiting for confirmations.` | `In a block — waiting for confirmation.` |
| `src/components/pampalo/SendModal.tsx:1006` | `The transaction reverted on-chain. No funds moved.` | `The transaction failed. No funds were moved.` |
| `src/components/pampalo/send/SendReviewStep.tsx:320` | `Transaction reverted on-chain.` | `The transaction failed and didn't go through. No funds were sent.` |

### Receive / QR setup screen (`ReceiveQRStep.tsx`) — heavily jargon-laden

| Location | Current | Proposed |
|---|---|---|
| `:148` | `Derive your {network} envelope` | `Set up your {network} private key` |
| `:150` | `{network} uses an isolated envelope key (slot 420) so a future hot-Sync compromise can't reach it. Unlock once to derive and cache it locally.` | `{network} uses a separate key for extra protection of your private payments. Unlock once to create it — it's stored only on this device.` |
| `:173` | `Unlock to derive` | `Unlock to set up` |
| `:128` | `This is a link that contains all of your address details easily copyable for Private Money on Pampalo ({network}).` | `A single link with all your receiving addresses for {network} — easy to share so others can pay you on Pampalo.` |
| `:263` | `This code includes your public + shielded addresses together. Anyone you share it with can link your EVM identity to your shielded identifiers.` | `This code includes your public and private addresses together. Anyone you share it with can connect your public wallet to your private one.` |
| `:65` | `Couldn't derive — ${msg}` | `Couldn't set up your key — please try again.` |

### Landing & meta copy (first thing a new user reads)

| Location | Current | Proposed |
|---|---|---|
| `src/routes/index.tsx:245` | `Pampalo uses passkey PRF (Pseudo-Random Function) to encrypt and decrypt all application data.` | `Pampalo uses your passkey to encrypt and decrypt everything in the app.` |
| `src/routes/index.tsx:249` | `Any data stored in the database is encrypted with (pass)keys that you control.` | `Anything we store is encrypted with keys only you control.` |
| `src/routes/__root.tsx:45` (meta description) | `Pampalo uses passkey PRF to encrypt and decrypt all application data…` | `Pampalo encrypts and decrypts all your data with your passkey. Anything stored is encrypted with keys only you control.` |
| `src/routes/__root.tsx:54` (OG description) | `…Your keys, your data - encrypted client-side, stored as ciphertext.` | `…Your keys, your data — encrypted on your device before it's ever stored.` |
| `src/routes/index.tsx:400` | `Pampalo encrypts your wallet with a feature called the WebAuthn PRF extension…` | `Pampalo needs a passkey security feature (the WebAuthn PRF extension) to encrypt your wallet…` (keep the rest) |
| `src/components/pampalo/RecoverAccount.tsx:227` | `"{word}" isn't in the BIP-39 word list. Check for typos.` | `"{word}" isn't a valid recovery word. Check for typos.` |

---

## Tier 3 — Error messages: terse, dead-end, or raw

Error copy is where users get hurt most. These either expose a raw
`Error.message`, give no next step, or are cryptic internal-state strings.

| Location | Current | Proposed |
|---|---|---|
| `src/lib/auth-errors.ts:8` | `Your passkey provider doesn't support the encryption extension Pampalo needs.` | `This passkey can't be used to secure your wallet. Try a different passkey, or set up a recovery passphrase instead.` |
| `src/lib/auth-errors.ts:18` | `The passkey you picked isn't registered with Pampalo on this account.` | `That passkey isn't linked to this Pampalo account. Pick the passkey you used to sign up, or recover with your phrase.` |
| `src/lib/broadcast-error.ts:31` | `The transaction would fail on-chain and was not sent.` | `This transaction would fail, so it wasn't sent. Double-check the amount and recipient.` |
| `src/lib/broadcast-error.ts:34` | `Couldn't broadcast the transaction.` | `Couldn't send the transaction. Please try again.` |
| `src/components/pampalo/send/SendReviewStep.tsx:388` | `Private send not ready` | `Couldn't start the private send. Please try again.` |
| `src/components/pampalo/send/SendReviewStep.tsx:569` | `Public send not ready` | `Couldn't start the send. Please try again.` |
| `src/components/pampalo/SendModal.tsx:892` | `Receipt lookup failed` | `Couldn't check the transaction status. Retrying…` |
| `src/components/pampalo/SwapModal.tsx:359` | `Quote failed` | `Couldn't get a quote — try a different amount.` |
| `src/routes/sentry.tsx:186` | `Refresh failed` | `Couldn't refresh — please try again.` |
| `src/components/pampalo/shield/CancelShieldSheet.tsx:185` | `setError(e.message)` (raw error to UI) | Route through `normalizeBroadcastError` like the sibling sheets do, so users never see a raw ethers/RPC string. |
| `src/components/pampalo/PageLayout.tsx:116` | `Sync failed — try again` | `Couldn't sync your preferences. Try again.` |
| `src/routes/wallet.tsx:747` | `Sync failed - try again.` | `Couldn't sync — please try again.` |

Also: replace the recipient-facing **"Sync"** instruction wherever it appears
(`SendReviewStep.tsx:329,849`; `BoothSendBar.tsx:479`) with
"refresh their Pampalo wallet" — the recipient has no feature called "Sync".

---

## Tier 4 — Tone, voice, and consistency polish

| Location | Current | Proposed | Why |
|---|---|---|---|
| `src/components/pampalo/GasTierPicker.tsx:38` | `Stupid fast` | `Fastest` | "Stupid" reads as slang in a screen where users spend real money. |
| `src/components/pampalo/GasTierPicker.tsx:45-46` | `priority bump` / `next-block, no questions asked` | `faster confirmation` / `fastest confirmation` | Jargon + filler. |
| `src/components/pampalo/BalanceCard.tsx:14-17` | `hey! you should sync` / `there could be some new things to sync` / `sync time? or not aha` | `Balances may be out of date — tap Sync` / `New activity to sync` / `Tap Sync to refresh your balances` | The third is filler ("or not aha"); inconsistent voice across the three. |
| `src/routes/index.tsx:281,304` | `Sign in with Passkey` vs `Sign in with passkey` | Standardize on `Sign in with passkey` | Casing flip-flops on one screen. |
| `src/components/pampalo/WarningChip.tsx:4` | `Pampalo is Experimental` | `Pampalo is experimental` | Sentence case to match the footer disclaimer. |
| `src/components/pampalo/SwapModal.tsx:494` | `On-chain swap from your public balance — visible, address-linked.` | `A normal swap from your public balance — visible on the blockchain.` | "address-linked" jargon. |
| `src/components/pampalo/SwapModal.tsx:497` | `Shielded swap between your private notes — ownership stays hidden.` | `A private swap between your hidden balances — no one can see it's you.` | "Shielded"/"notes" jargon. |
| `src/components/pampalo/AssetSelect.tsx:129,621` | `Pick token` / `Nothing found.` | `Select token` / `No tokens match your search.` | Consistency + warmer empty state. |
| `src/components/pampalo/SendModal.tsx:792` | `Asset sent value` | `Amount sent` | Awkward phrasing. |
| `src/components/pampalo/deposit/network-meta.ts:7-21` | `L1 · Settlement`, `L2 · Lower fees`, `EVM network` | `Main network · Most secure`, `Faster & cheaper`, `Blockchain network` | "L1/L2/EVM/Settlement" are crypto jargon as taglines. |
| `src/routes/clear.tsx:99` | `…The next visit to / will be a fresh registration.` | `…Your next visit to the home page will start fresh.` | Leaks the literal `/` path. |

### Items reviewed and judged OK (no change needed)

The strong safety copy is already good and should be the model for the rest:
`MnemonicReveal.tsx` ("Anyone with these 12 words can take your wallet…"),
`SendModal.tsx:637` ("Double-check the address — sends can't be reversed."),
`SelfBroadcastFallback.tsx` (clear privacy warning),
`RetiredNotesHistory.tsx:188` (jargon-free explanation),
`account.tsx:128` (recovery-phrase setup). Most button labels, the
`ModeSegmented` Public/Private toggle, and standard network names are fine.

---

## Operator surfaces (`/sentry`) — lower severity

These are tools for booth operators and compliance signers, not end users, so
protocol terms ("leaf", "epoch", "relayer") are more defensible. Still worth
softening the avoidable ones:

| Location | Current | Proposed |
|---|---|---|
| `src/routes/sentry.tsx:239,243` | `Shield queue` / `Pending shields across every Pampalo deployment. Vigilant citizens contest; anyone can sponsor a finalise…` | `Private transfer queue` / `Private transfers waiting to be finalized across Pampalo. Watchers can flag suspicious ones; anyone can help finalize one once its waiting period ends.` |
| `src/routes/sentry.tsx:675,952,973,1013` | `Shielder` / aria `Copy shielder address` / `View shielder…` / `View shield transaction…` | `Sender` / `Copy sender address` / `View sender…` / `View transaction…` |
| `src/routes/sentry.tsx:1124` | `Sponsor finalise` | `Help finalize` |
| `src/routes/sentry.tsx:179` | `Slow down — refreshes throttled to 5s` | `Just a sec — you can refresh again in a few seconds.` |
| `src/components/pampalo/sentry/ActionConfirmSheet.tsx:237,238,457` | `Leaf in the tree. Note is spendable.` / `Note is spendable.` / `Leaf inserted into the merkle tree. The note is now spendable.` | `Shield finalised. The balance is now spendable.` |
| `src/components/pampalo/sentry/ActionConfirmSheet.tsx:325,329` | warnings referencing `the leaf will be inserted into the merkle tree` | `…finalises the shield immediately.` / `…the shielded balance becomes spendable.` |
| `src/components/pampalo/sentry/ContestSheet.tsx:179`, `ActionConfirmSheet.tsx:204` | `setError(e.message)` (raw) | Route through a friendly normalizer. |
| `src/components/pampalo/Footer.tsx:64` | `Sentry` (footer link) | Consider `Status` — "Sentry" collides with the well-known error-monitoring product and is opaque. |

Role codenames **"Vigilant Citizen"** and **"Booth Operator"** appear to be
intentional product branding; left as-is, flagged for a product decision.

---

## Suggested rollout order

1. **Tier 1** — the ADR leak, the `Convex`/`bb.js` leaks, dev-only hints, and
   raw `chain <number>` strings. Small, unambiguous, highest embarrassment.
2. **Tier 2** — adopt the glossary and sweep "shielded/Poseidon/Envelope/note"
   out of all end-user screens in one consistent pass.
3. **Tier 3** — error messages (also a good moment to route the remaining
   `setError(e.message)` call sites through `normalizeBroadcastError`).
4. **Tier 4** — tone and polish.

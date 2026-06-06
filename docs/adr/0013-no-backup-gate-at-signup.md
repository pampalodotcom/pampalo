# Signup never displays the recovery phrase

Registration completes and the user lands directly on the wallet home —
no reveal screen, no type-three-words confirmation, no skippable backup
step. The **synced passkey** (iCloud Keychain / Google Password Manager)
is the primary recovery mechanism; the **recovery phrase** is the escape
hatch, reachable any time via "Export recovery phrase" on the Account
page. A persistent "Back up your recovery phrase" banner on the wallet
shell nudges toward that flow until the user completes an export
(Copy or Download), which sets `mnemonicBackedUpAt` inside the encrypted
preferences blob. This supersedes AUTH.md §10's original
"don't accept skip in v1" stance.

## Why not gate signup on backup

- **The gate was already theater.** The shipped flow had an
  "I'll do this later" link, and both the confirmed and skipped paths
  ran identical code. The server can't enforce backup either — it never
  sees the plaintext, so "user really wrote the words down" is
  unverifiable by construction. A gate we cannot enforce buys friction,
  not safety.
- **Forced reveal at signup is the worst moment for it.** The user has
  zero funds at stake, no context for what the words are, and a strong
  incentive to click through. A nudge that persists once they have a
  balance worth protecting is better aligned with the actual risk.
- **Plaintext backup tracking is forbidden anyway.** A server column
  like `mnemonicConfirmedAt` is a behaviour timestamp linked to a wallet
  row — exactly what ADR 0001's privacy invariant rules out. (The dead
  `mnemonicConfirmedAt` schema field is removed as part of this change.)

## Consequences

- **A user on a non-syncing authenticator who never exports can lose
  funds permanently.** Passkey gone + no phrase = unrecoverable, and
  they were never forced to see the phrase. Accepted deliberately; the
  banner exists to shrink this cohort, and a one-click encrypted cloud
  backup integration (Google / Microsoft) is the planned low-friction
  path for it.
- **`mnemonicBackedUpAt` is monotonic.** It lives in the encrypted
  `userPreferences` blob and merges as `max(upstream, local)` regardless
  of the sync dirty flag — a stale device must never un-back-up a
  wallet (plain last-write-wins would re-show the banner forever).
- **Recover account sets `mnemonicBackedUpAt` itself.** Recovery starts
  a fresh `userId` and therefore a fresh prefs blob (ADR 0003), but the
  user just proved possession of the phrase by typing it — nagging them
  to back up would be wrong.
- **`MnemonicReveal`'s setup/confirmation mode is deleted, not hidden.**
  The export-mode reveal (blur, Copy, Download, clipboard hygiene) is
  the only remaining display surface, per AUTH.md §10.

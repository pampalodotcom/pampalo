# Transfers are multi-recipient in v1 (shields remain self-only)

ADR 0008 restricted v1 to self-shield. `TRANSFERS.md §1` initially
extended that to transfers (self-to-self only; transfer's job in v1
was denomination management). This ADR reverses the transfer half of
that posture: **`Pampalo.transfer(...)` in v1 accepts an arbitrary
recipient.** The sender supplies the recipient's Poseidon identifier
and envelope public key directly via the Send sheet (manual entry or
payment-code paste, per the front-end design spec).

ADR 0008 still stands for **shield**: the shield slider has no
recipient picker, and the slider's "PRIVATE" side is always the
user's own private balance.

## Why the asymmetry

The shield surface and the transfer surface have different cost
structures for adding cross-recipient support:

- **Shield's friction is at the slider.** Adding a recipient picker
  to the slider means a network-by-asset surface every Pampalo user
  sees and never uses by default. The marginal user value of
  third-party shields is low — depositors typically want their *own*
  shielded balance, not someone else's. The slider stays focused.
- **Transfer's friction is bidirectional and unavoidable.** Without
  multi-recipient transfers, the transfer feature only does
  denomination management — split, merge, refresh. That's not what
  users expect from "send privately"; it's not what a demo
  audience expects to see. The Send sheet already needs a recipient
  surface (the public mode has a `0x…` field); adding the Poseidon +
  Envelope pair in private mode is a straight extension, not a new
  UI category.

The transfer recipient is **provided by the sender at compose time**
— either typed manually or pasted as a payment code. There is no
on-chain envelope-key registry, no contacts CRUD (deferred), and no
discovery problem on the sender side. The sender knows who they want
to pay; they paste the code the recipient shared with them out of
band.

## What this turns on (the cascading scope)

Cross-recipient transfer requires a receiver-side discovery path that
self-only transfer didn't need. When Alice sends Bob a private
transfer:

1. Alice builds the proof with Bob's Poseidon as `owner` and
   ECIES-encrypts the four-tuple to Bob's envelope public key.
2. Alice broadcasts (relayer or self-broadcast fallback).
3. The contract emits `NotePayload(ciphertext)` for the output
   commitment.
4. **Bob's device has to discover this note.** There is no
   `shielder == self.evm` shortcut — the on-chain row has no field
   that identifies Bob without first decrypting.

The receive path therefore requires:

- A Convex indexer that mirrors `NotePayload` events from
  `Pampalo.transfer` calls into a new `transferNotes` table (or an
  extension of `shieldQueueEntries`, but a separate table is cleaner
  for the different event shape).
- A client-side **trial-decrypt scanner** that walks the upstream
  events with the user's envelope private key, attempting ECIES
  decrypt on each. Notes that decrypt belong to the user and land in
  IDB with `origin: "transferIn"`.
- IDB `notes.origin` already has the `"transferIn"` variant
  reserved (see `idb-notes.ts`). The writer path is the unfinished
  side.
- A sync UX. The simplest fit is to extend the existing
  `syncShieldNotesExplicit` (the wallet's Sync button) so a single
  PRF ceremony refreshes both shield-receive notes and transfer-in
  notes.

At Pampalo's expected initial scale (Base Sepolia, low traffic) the
trial-decrypt cost per Sync is trivial. At mainnet scale this
becomes a background scanner + sync-cursor design problem; punt
that until it matters.

## What this does not change

- Shield-to-self stays the slider's behaviour. ADR 0008 holds.
- The shield-receive sync path (`syncShieldNotesExplicit`,
  `shieldQueueEntries.byShielder`) is unaffected — every shielded
  note still has a `shielder` field tying it to the depositor's
  EOA. The new scanner is *additive*.
- The relayer architecture in `TRANSFERS.md` and ADR 0010 is
  unaffected. The relayer broadcasts whatever proof the client
  builds; it does not care who the recipient is.
- Optimistic IDB writes still work for the sender side: the sender
  knows the output note plaintext at proof-gen time (it's their
  input to `prepareTransfer`), so they can write the *sender's*
  view of the tx without any decrypt.

## Related

- ADR 0008 — shield-to-self, still in effect.
- `TRANSFERS.md` — §1 amended to remove the cross-recipient
  restriction; a new section covers the receiver-side scanner.
- `CLIENT_SIDE_FIRST.md` — flagged the trial-decrypt scanner as
  deferred. This ADR pulls it forward for transfers only.

# Retired notes are derived, retained, and archived — not cleared

After a clean-break redeploy (ADR 0017), a user's local notes from the old
contract can never be spent against the new verifiers. We **keep** those
notes as read-only history rather than deleting them, classify them as
**retired by derivation** (no stored flag, no migration pass), and archive
the server-side material needed to reconstruct them on a fresh device
**before** the redeploy wipe runs. `/clear` is not part of the cutover.

This refines ADR 0017's "Clients hold stale local state → they clear via
`/clear`" consequence, which was a placeholder for exactly this design.

## The decision

1. **Retirement is derived, not stored.** A `StoredNote` already carries
   `(networkChainId, deploymentAddress)`. A note is *retired* iff that pair
   is absent from the live `enabledDeployments()` set:

   ```
   isRetired(note) = !enabledDeployments.some(d =>
     d.chainId === note.networkChainId &&
     d.pampaloAddress === note.deploymentAddress)
   ```

   No `retired` boolean, no one-time stamping pass, no re-stamping on the
   next redeploy — vN automatically retires vN-1 notes. See **Retired note**
   in `CONTEXT.md`.

2. **The spend filter must respect the discriminator.** Before this ADR the
   spendable-note filter matched only `networkChainId === chainId` and
   *ignored* `deploymentAddress`. Post-cutover that would offer a retired v1
   note as spendable; proof prep against the v2 contract then fails. The
   filter (and spendable-balance) now require
   `deploymentAddress === activeDeployment.pampaloAddress`. This is the
   load-bearing correctness fix — everything else is presentation.

3. **Retired notes are retained and hidden behind an advanced view.** They
   never appear in the main wallet or spend picker. They surface read-only
   under **Settings → History → Previous deployments**, grouped per old
   deployment (`v1.x · retired <date>`), showing asset + amount only.

4. **Durable cross-device history via archive-before-wipe.** The redeploy
   wipe (ADR 0017) is mandatory for correctness, so the old rows can't just
   be left in place. Instead `seedAll`, on an address change, **copies** the
   user-recoverable material into archive tables *before* calling
   `wipeDeploymentChildren`:
   - `archivedShieldQueue` ← `shieldQueueEntries` (self-shields, queryable
     by `shielder`)
   - `archivedTransferNotes` ← `transferNotes` (received-note ciphertexts,
     trial-decrypted client-side)
   - `archivedDeployments` ← a one-row identity marker (old address,
     chainId, version label, `retiredAt`) so the History panel can label the
     group.

   `pampaloLeaves` and `pampaloActivity` are **not** archived — leaves are
   positional (a retired note is never proven, so its leaf index is dead
   weight) and activity is the public Sentry feed, out of scope for
   *user-note* history.

5. **`/clear` is not the migration tool.** It stays hands-off: it never
   touched the notes IDB store and still doesn't. At cutover, on an existing
   device, derived retirement drops v1 notes from the spend flow and the
   server wipe yields a clean v2 tree mirror — so **no client reset is
   needed**. `DEPLOYMENT.md` step 5 is corrected accordingly.

## Why these choices

- **Derive vs. stored flag.** A stored flag needs a migration pass at every
  redeploy and a place to run it; the discriminator we already persist makes
  it free and self-maintaining. The only cost is that retirement is
  unknowable until `enabledDeployments()` loads — which the spend path
  already gates on (`inputNote` is null until deployments resolve).

- **Server archive vs. device-local only.** Retired history could have been
  left as "whatever this device cached" — zero server work, honest for
  testnet mock tokens. We chose the archive so history survives a fresh
  device / reinstall. On a *future* mainnet the runbook drains value before
  redeploy, so retired notes are value-less artifacts either way; the
  archive is about auditability, not recovering funds.

- **Why not a second `pampaloDeployments` row for v2** (which would dodge the
  leaf collision for free by giving v2 a fresh `deploymentId`)?
  `pampaloDeployments` is `.unique()` on `by_networkId` — one row per chain —
  and that invariant is relied on by `addDeployment`, `seedAll`,
  `enabledDeployments()`, and the indexer cursor. Allowing two rows per chain
  ripples through all of them. Archiving into separate tables keeps the
  invariant and is the more surgical change.

## Consequences

- **The archive code gates the re-seed.** Items 2–4 (schema, `seedAll`
  archive step, queries) must be deployed **before** `seedAll` runs on a
  redeploy, or the existing wipe destroys v1 to device-local-only. The
  runbook calls this out.
- **No leaf/activity history for retired deployments.** Deliberately scoped
  out (ADR offers a "full snapshot" path if Sentry ever needs cross-version
  pool history — not built).
- **History is reconstructed by trial-decrypt**, same as live sync: a fresh
  device queries the archive, decrypts with the envelope key, and the result
  derives as retired. Nothing new is trusted to the server.

## Related

- `docs/adr/0017-non-upgradeable-clean-break-redeploys.md` — the clean-break
  + mandatory-wipe model this builds on (and whose `/clear` consequence this
  supersedes).
- `DEPLOYMENT.md` — runbook (step 5 corrected here).
- `CONTEXT.md` — **Retired note**, **Pampalo deployment**.
- `convex/shieldQueue/seed.ts` — `seedAll` archive-before-wipe.

Remaining big tasks (sequenced; decisions in CONTEXT.md + ADRs 0015/0016):

- [ ] open source this repo — MIT everything (app + contracts + packages). LICENSE + per-package license fields + secret-scrub git history.
- [~] convex relayer (sponsored transfer + unshield). Gated by non-zero proof -> eth_call sim -> monthly cap. RELAYER_MNEMONIC env. Show first 5 accounts on /sentry. ADR 0015.
      DONE: schema; derivation; acquire/release LRU; relay action (transfer+unshield); reconcile + zombie crons; seed; client wiring (relay-vs-self + consent fallback in unshield + transfer sheets); /sentry gas-sponsor panel.
      TODO: operator activation — fund the 5 Base Sepolia accounts; live end-to-end exercise (TRANSFERS.md §8).
- [ ] CONTRACT REDEPLOY (Base Sepolia) — ships the $200 cap, unshieldBudget(), and fast-track changes on-chain, AND grants VIGILANT_CITIZEN_ROLE to the index-5 compliance signer. Gates the compliance cron's auto-contest. Operator step.
- [x] $200/month cap — DONE on-chain (code+tested): default $100->$200, separate shield/unshield buckets, unshieldBudget() view + isFastTracked(). Needs redeploy.
- [~] blacklist index + automated chainalysis checker. ADR 0016.
      DONE: blockedAddresses + complianceCursors tables; store (add/remove/exact-remove/list/screen/stats/cursor); compliance/node scanAndContest (blocklist + live oracle -> eth_call sim -> contest via index-5 signer; COMPLIANCE_AUTO_CONTEST safety flag); compliance/oracle indexChainalysisOracle (full day-1 backfill via Added/Removed events on eth-mainnet, cursor-resumed) + ingestAddressList/ingestConfiguredLists (operator-URL Railgun/OFAC); crons (scan 2m, oracle 1h, lists 24h); docs-site /compliance page.
      TODO (operator): ensure ALCHEMY_API_KEY has eth-mainnet; run compliance/oracle:indexChainalysisOracle 2-3x to backfill; set RAILGUN_BLOCKLIST_URL/OFAC_BLOCKLIST_URL to auto-ingest; fund+grant VIGILANT_CITIZEN_ROLE to index-5 signer; flip COMPLIANCE_AUTO_CONTEST=1.
- [x] 'no wait this month' fast-track — DONE on-chain (code+tested): per-user monthly fastTrackAllowedMonth + setFastTrackAllowed (BOOTH_OPERATOR), _queueShield skips wait. Skips contest window by design. Needs redeploy.
- [~] sentry surfaces: relayer-pool panel DONE. Explorer Phase 1 DONE — pampaloActivity table + indexer (NullifierUsed/NotePayload triggers, fn-selector classification), recentActivity query w/ relayer attribution, PoolActivityPanel (classified transfer/withdrawal feed: type, time, relayer #N/self-broadcast, shortened ECIES payload, tx->explorer link, filter-aware).
      TODO Phase 2: search (txHash / shielder addr / leaf hash) + capture unshield EXIT RECIPIENT for "unshielder" search; shortened payload + explorer links on shield queue rows (pending/confirmed); per-user cap/budget viewer.
- [x] EXTRA (today): shield/unshield slider responsiveness fix; private-send "resync" copy; affordability preflight + RPC-error normalization across send/shield/unshield (CONTEXT.md "Affordability preflight").

### Pampalo The Company

in docs site - need to add this text to this page:

```
Pampalo never custodies any of its users funds. 

Pampalo reserves the right to refuse entry to anyone - and can stop offering private money shielding at any time by calling the `weAreFull()` function. This disables shielding into the pool - but all users can still withdraw their funds, just not encrypt any more.
```

### Compliance Tracking

Currently pampalo inherits and reuses the security infrastructure of railgun and other good actors in the space.



### lesser priority
- change derivation path of ECEIS (envelope key) to another non-zero path (so all paths for EVM address, Envelope and poseidon keys are all different)

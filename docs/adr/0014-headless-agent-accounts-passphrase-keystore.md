# Headless agent accounts use a scrypt-passphrase keystore

Pampalo gains a CLI / SDK (`@pampalo/cli`, `@pampalo/sdk`) so Node/TS
agents can hold and operate Pampalo identities headlessly — an **agent
account**. An agent account custodies its **mnemonic** at rest in a
scrypt + AES-GCM encrypted keystore file under `~/.pampalo/` (modelled on
`~/.ssh/`), unlocked by passphrase and held in process memory for the run.

This **directly re-permits the scrypt-passphrase scheme that ADR 0002
deleted** — but only on the CLI/SDK surface, never in the browser wallet.

## Why this does not contradict ADR 0002

ADR 0002 removed the passphrase fallback because, *in the browser*, the
WebAuthn PRF extension is always available, so a passphrase path was pure
downside (weaker security, more code) with no user it served. That
rationale is environment-specific. A Node process has **no WebAuthn
authenticator and no PRF** — there is no KEK to derive from a passkey.
The choice in a CLI is not "PRF vs passphrase"; it is "passphrase-encrypted
keystore vs plaintext-on-disk vs no headless accounts at all." Against
that real menu, a scrypt-passphrase keystore is the strongest option that
still lets an agent run, and it is the convention every comparable
signing CLI uses (`ssh-keygen`, `gpg`, Foundry `cast wallet import`).

The web wallet's hard PRF gate is unchanged. ADR 0002 stands for that
surface.

## What we picked over

- **Plaintext mnemonic at `~/.pampalo/…`, mode 0600** (the AWS/kubectl
  convention). Rejected: a Pampalo mnemonic is irrevocable — it *is* the
  identity — unlike a revocable cloud API key, so a disk/backup leak is
  total and permanent compromise. It also betrays the project's own
  client-first "encrypt everything at rest" ethos on the least-trusted
  device (a dev laptop, a CI runner).
- **OS keychain only** (keytar / native secret store). Rejected as the
  sole mechanism: native dep, no story in bare containers / CI. Kept as a
  possible future cache for the deferred agent daemon, not the source of
  truth.
- **Reusing the web auth model.** Impossible: no authenticator exists in
  Node, so there is nothing to gate a KEK on.

## Surrounding posture (recorded here, decided alongside)

- **Separate identity.** `pampalo init` generates a *fresh* mnemonic — a
  distinct identity from the user's human web wallet — so an agent never
  holds the keys to the human account. `pampalo import` brings in an
  existing **recovery phrase** as an explicit opt-in. An agent account has
  no Convex **wallet** row and no **credential**.
- **Pure on-chain v1, self-broadcast.** v1 needs no Convex session.
  Private state is local (SQLite note store + keystore); chain reads and
  broadcast go through the existing `RpcClient` seam pointed at a
  user-supplied RPC URL. Because the relayer (`transfers.relay`) is
  Convex-session-gated and unreachable from a sessionless CLI, day-1
  **Transfer** and **Unshield** self-broadcast — linking the agent's EVM
  address to the on-chain event. Tolerable for a sandboxed agent identity;
  closed when the Convex transport + relayer path lands.
- **Intent / sign separation.** The SDK separates building a transaction
  intent from signing+broadcasting it, so the same builder later feeds the
  keyless **Proposal** flow (agent proposes an ECIES-encrypted intent to a
  human's account; the human approves with their passkey).

## Consequences

- The deleted passphrase code is *not* resurrected in `convex/auth.ts` /
  the web wallet. The keystore + scrypt KDF live entirely in
  `@pampalo/sdk`; the browser bundle never imports them.
- A future ssh-agent-style daemon (cross-invocation unlock reuse, OS
  keychain cache) can be added without changing the at-rest format.
- The privacy floor for agent transfers is **weaker than the web
  wallet's** until the Convex/relayer path is wired. This is named, not
  hidden: the CLI surfaces self-broadcast linkage the way the web app's
  self-broadcast fallback does.

The trade-off is locked for the CLI surface, not permanent: when the
Convex-backed transport + API-key auth land, relayer privacy and
server-side note hydrate become available to agent accounts without
changing the keystore decision recorded here.

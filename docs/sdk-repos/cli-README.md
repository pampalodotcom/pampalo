# @pampalo/cli

> The `pampalo` command-line tool — a thin wrapper over `@pampalo/sdk`.
> Every command is a 1:1 call into an SDK method, so a human at a terminal
> and an agent importing the SDK have identical capability.

A new workspace package in the monorepo (`cli/`). **Hold no protocol logic
here** — parse
args, call `@pampalo/sdk`, format output. If you're tempted to do crypto,
chain reads, or persistence in this repo, it belongs in `sdk`.

---

## Where it sits

```
@pampalo/shared   protocol crypto
@pampalo/sdk      Account, keystore, store, sync, broadcast   ← dependency (workspace:*)
@pampalo/cli      ← you are here. bin: `pampalo`.
```

**Dev loop:** workspace packages in one monorepo — `@pampalo/sdk` resolves
locally, no linking. Changesets publishes `shared` → `sdk` → `cli` in order.

## Command surface (day-1)

Verbs map 1:1 to the protocol glossary. `transfer` is the **private**
note→note move; `send` is the **public** EVM move — they are deliberately
**not** merged under one `send` verb (the glossary reserves "Send" for the
public path; an agent must never confuse the two).

```
pampalo init                      # create a fresh agent account (new mnemonic + keystore)
pampalo import                    # import an existing recovery phrase
pampalo balance  [--account n] [--chain id]
                                  # public + private balances + shield statuses
pampalo sync     [--chain id]     # scan chain, rebuild notes/tree

pampalo transfer --poseidon 0x.. --envelope 0x.. --asset 0x.. --amount <n> --chain id
                                  # private note→note (self-broadcast in day-1)
pampalo send     --to 0x.. --asset 0x.. --amount <n> --chain id
                                  # public ERC-20 / native EVM transfer
pampalo shield   --asset 0x.. --amount <n> --chain id
                                  # public → private note (to self, v1)
pampalo unshield --asset 0x.. --amount <n> --recipient 0x.. --chain id
                                  # private note → public ERC-20
```

Global flags: `--account <name>` (defaults to the configured default
account), `--chain <id>`. RPC URL + default chain/account come from
`~/.pampalo/config.toml`; `PAMPALO_MNEMONIC` env overrides the keystore for
ephemeral/CI runs.

### Notes on specific commands

- **`balance`** prints public (RPC) + private (sum of spendable notes) and
  a shield table: `queued → executable → executed` (approved) vs
  `cancelled` / `contested` (disallowed).
- **`transfer`** day-1 takes raw `--poseidon` + `--envelope`.
  `--to alice.pampalo.eth` (L1 resolver) is a deferred fast-follow.
- **`transfer` / `unshield`** self-broadcast in day-1, which **links the
  agent's EVM address on-chain**. Print a one-line privacy notice when
  they run, mirroring the web app's self-broadcast confirm.

## Unlock UX

- The **SDK** holds the decrypted key in-process for the run. For the CLI,
  v1 either re-prompts for the passphrase per command or reads
  `PAMPALO_MNEMONIC`. An `ssh-agent`-style daemon (`pampalo unlock`) for
  cross-invocation reuse is **deferred** — do not build it in v1.

## Module layout

```
src/
  index.ts          #!/usr/bin/env node  — commander program
  commands/
    init.ts import.ts balance.ts sync.ts transfer.ts send.ts shield.ts unshield.ts
  config.ts         read/write ~/.pampalo/config.toml
  format.ts         table / json output helpers (support --json for agents)
```

Add `--json` to every command — agents parse structured output far more
reliably than tables.

## Dependencies

`@pampalo/sdk` (`workspace:*`), `commander` (arg parsing), a TOML parser. Nothing
else — no ethers/crypto directly.

## Build & publish

`tsup` with a shebang banner so `dist/index.js` is executable.
`package.json`:

```jsonc
{
  "name": "@pampalo/cli",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/pampalodotcom/pampalo.git", "directory": "cli" },
  "bin": { "pampalo": "./dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public", "provenance": true },
  "dependencies": { "@pampalo/sdk": "workspace:*", "commander": "^x" }
}
```

Root MIT `LICENSE`. Published by the monorepo's Changesets + OIDC workflow
(trusted publisher `pampalodotcom/pampalo`).

After publish, the day-one goal holds:

```
pnpm add @pampalo/sdk @pampalo/cli
pampalo init && pampalo balance
```

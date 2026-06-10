
# @pampalo/shared

> Protocol-level cryptography for Pampalo: notes, ZK proofs, ECIES note
> encryption, and the Poseidon merkle tree. Framework-agnostic, runs in
> the browser **and** Node. This is the bottom layer of the
> `shared → sdk → cli` stack.

`@pampalo/shared` is **already written** (it powers the web wallet today).
This repo's job is to **harden it for public npm publication** and
**verify it runs under Node**, not to author it from scratch. Treat the
existing classes as the source of truth; change behaviour only where Node
support demands it.

---

## Where it sits

```
@pampalo/shared   ← you are here. Pure protocol crypto. No internal deps.
@pampalo/sdk      depends on @pampalo/shared (npm). Account, keystore, store, sync.
@pampalo/cli      depends on @pampalo/sdk (npm). The `pampalo` binary.
```

`shared` has **no `@pampalo/*` dependencies** — it is the root of the stack
and must publish first.

## Glossary (canonical — keep language consistent with the main repo)

- **Note** — the unit of private value: a four-tuple `(asset_id,
  asset_amount, owner, secret)` committed to a merkle tree as
  `poseidon2([asset_id, asset_amount, owner, secret])`. `owner` is a
  **Poseidon identifier**; `secret` is per-note unlinkable randomness.
- **Note secret** — the `secret` field; ECIES-encrypted to the recipient's
  **envelope key** and emitted on-chain so only the recipient can spend.
- **Poseidon identifier** — `poseidon2([BigInt(privateKey)])` over BN254,
  zero-padded to 64 hex. The unlinkable on-chain note recipient.
- **Envelope key** — uncompressed secp256k1 public key (`0x04 || X || Y`),
  the ECIES target for a note secret.
- **Transfer / Shield / Unshield** — private→private / public→private /
  private→public moves. `Transfer` is **never** called "Send".

These nouns are load-bearing. Do not rename them. The full glossary lives
in the main repo's `CONTEXT.md`.

## Responsibilities

| In scope | Out of scope |
|----------|--------------|
| Note encode/decode + ECIES (`Note.ts`) | Key custody / mnemonics (→ sdk) |
| Proof generation: Transfer/Shield/Unshield (`*.ts` + `circuits/*.json`) | Persistence / SQLite (→ sdk) |
| `PoseidonMerkleTree` (insert, root, proof) | RPC / broadcast (→ sdk) |
| bb.js WASM lifecycle (`bb-api.ts`, `bb-teardown.ts`) | CLI / argument parsing (→ cli) |
| ZK + tree constants (`constants/`) | Address derivation from a mnemonic (→ sdk) |

## Existing public surface (keep stable)

```ts
// classes/Note.ts
NoteEncryption.encryptNoteData(data, recipientPubKey): Promise<string>  // ECIES blob
NoteDecryption.decryptNoteData(blob, privateKey): Promise<FourTuple>     // trial-decrypt

// classes/Transfer.ts / Shield.ts / Unshield.ts / UnshieldBundled.ts
new Transfer(); await t.init(); t.transferNoir / t.transferBackend        // proof gen

// classes/PoseidonMerkleTree.ts
tree.insert(leaf); await tree.getRoot(); await tree.getProof(leafIndex)
```

The `sdk` consumes exactly these. Breaking changes here ripple to two
downstream packages — version with care.

## Work to do in this repo

1. **Verify Node proof-gen (the gating spike).** Run `Transfer.init()` +
   `generateProof` from a bare Node script. `@aztec/bb.js` and
   `@noir-lang/noir_js` are WASM; confirm they initialise under Node 20+
   without a browser shim. If `bb-api.ts` assumes a browser global, add a
   Node branch. **Nothing downstream can ship until this passes.**
2. **Add a build.** `tsup` → `dist/` with ESM `.js` + `.d.ts`. The
   circuit JSON at `circuits/*.json` is imported via JSON import
   attributes (`with { type: "json" }`) — ensure tsup keeps them resolvable
   (bundle them or ship `circuits/` and keep the import paths).
3. **Make it publishable** (see config below).

## Dependencies (runtime)

`@aztec/bb.js`, `@noir-lang/noir_js`, `@zkpassport/poseidon2`, `eciesjs`,
`ethers`. All Node-compatible. Keep them as regular `dependencies` — do
**not** bundle the WASM libs into `dist`.

## Build & publish config

```jsonc
{
  "name": "@pampalo/shared",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/pampalodotcom/shared.git" },
  "exports": {
    "./classes/*": { "development": "./classes/*.ts", "default": "./dist/classes/*.js" },
    "./constants/*": { "development": "./constants/*.ts", "default": "./dist/constants/*.js" },
    "./types/*": { "development": "./types/*.ts", "default": "./dist/types/*.js" }
  },
  "files": ["dist", "circuits"],
  "engines": { "node": ">=20" },
  "sideEffects": false,
  "publishConfig": { "access": "public", "provenance": true }
}
```

- `publishConfig.access: "public"` is mandatory — scoped packages publish
  *restricted* by default and 402 otherwise.
- The `development` export condition lets the main app keep consuming raw
  `.ts` (HMR) when this is `pnpm link`ed; npm consumers get compiled `dist`.
- Add an `MIT` `LICENSE` file.

## Release

Standalone `npm publish --provenance` via a `.github/workflows/release.yml`
using GitHub Actions OIDC trusted publishing (permissions `id-token:
write`, `contents: write`; `npm i -g npm@latest` for npm ≥ 11.5.1; **no
`NPM_TOKEN`**). Add `pampalodotcom/shared` as a trusted publisher on the
npm package after the first publish.

## Invariant

A note secret never leaves a device unencrypted, and proof witnesses are
never logged. This package handles plaintext secrets transiently inside
proof/ECIES calls only — never persist, never log them.

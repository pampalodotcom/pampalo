<div align="center">

<img src="./public/pampalo-circular.svg" alt="Pampalo" width="120" />

# Pampalo

**Private money. Your keys, your data.**

Passkey-encrypted, client-side-first private payments on EVM.

[![License: MIT](https://img.shields.io/badge/License-MIT-faf6ea.svg)](./LICENSE)
&nbsp;·&nbsp;
[Website](https://pampalo.com)
&nbsp;·&nbsp;
[Docs](https://docs.pampalo.com)
&nbsp;·&nbsp;
[Architecture](./AUTH.md)

</div>

---

> [!CAUTION]
> ### ⚠️ Experimental software — do not use with real funds
>
> Pampalo is **experimental, unaudited, pre-release software** published for
> research, transparency, and community review. It handles cryptographic keys
> and on-chain value, and it **has not been through a formal security audit**.
>
> - **Do not** store mnemonics, private keys, or funds you cannot afford to
>   lose entirely.
> - Cryptography, key-derivation, and smart-contract code may contain bugs
>   that result in **irreversible loss of funds** or **loss of privacy**.
> - The privacy properties described below are **design goals**, not
>   guarantees. They have not been independently verified.
> - APIs, database schemas, contracts, and on-chain deployments may change
>   in **breaking, non-backward-compatible ways** without notice
>   (see [ADR-0017](./docs/adr/0017-non-upgradeable-clean-break-redeploys.md)).
> - The software is provided **"as is", without warranty of any kind**. See
>   the [LICENSE](./LICENSE).
>
> If you find a security issue, please report it responsibly rather than
> opening a public issue.

---

## What is Pampalo?

Pampalo is a **ZK private-money protocol**: an EVM-anchored wallet whose
deposits become unlinkable on-chain notes, encrypted to recipients via ECIES
and identified on-chain by a SNARK-friendly hash of the owner's secret.

Encryption keys are derived **client-side** from the user's passkey using the
WebAuthn PRF extension. The [Convex](https://convex.dev) backend stores only
ciphertext and public material — even a full database compromise should not
reveal any user's mnemonic, transactions, or notes.

## Core principles

Pampalo is built around two hard constraints. Both are treated as
non-negotiable when reviewing any change.

### 🔒 The privacy invariant

> The server stores the encrypted **mnemonic** and the public material needed
> to verify a WebAuthn ceremony. **Nothing else.**

The plaintext mnemonic never leaves the client. Every new column on a
user-scoped table must be either (a) the encrypted mnemonic, (b) public
WebAuthn material (`credentialId`, `publicKey`, `counter`, `transports`), or
(c) an opaque protocol primitive (session token, expiry, random user id). No
user-supplied strings, no behavioural timestamps, no labels.

### 🌊 Client-side first

The Convex backend is intentionally minimalist: it holds public catalog data
(supported networks + tokens, price/gas snapshots, pool addresses),
short-lived auth state, and the ciphertext blobs governed by the privacy
invariant. Anything that can run in the user's browser does. The server is
designed assuming it is **hostile**: never accept plaintext that could be
encrypted client-side, never return decryptable data, gate writes on an
opaque session token.

See [`AUTH.md`](./AUTH.md) for the canonical encryption / passkey
architecture and [`CONTEXT.md`](./CONTEXT.md) for the protocol overview.

## How encryption works (in brief)

Passkeys **sign**; they don't encrypt. Pampalo gets an encryption key out of a
passkey via the WebAuthn **PRF extension** (`hmac-secret`), then uses envelope
encryption:

1. A random 32-byte **DEK** encrypts the mnemonic once with AES-256-GCM.
2. The DEK is wrapped per passkey by a **KEK** derived from that passkey's PRF
   output via HKDF.
3. The server stores the mnemonic ciphertext and the wrapped DEK(s) — never a
   plaintext key or any value that could derive one.

When a passkey provider doesn't expose PRF, Pampalo falls back to an ethers
passphrase-encrypted JSON keystore. Full details, including the threat model
and residual linkage we explicitly accept, live in [`AUTH.md`](./AUTH.md).

## Tech stack

- **Frontend** — React 19, TanStack Router/Start, Tailwind CSS v4, Vite
- **Backend** — [Convex](https://convex.dev) (ciphertext + public catalog only)
- **Auth / crypto** — WebAuthn PRF via `@simplewebauthn`, ethers, AES-GCM / HKDF
- **Chain** — EVM (Base / Ethereum), ZK notes via Poseidon2 + SNARK circuits
- **Contracts** — Solidity (Hardhat)

## Repository layout

| Path         | What's inside                                              |
| ------------ | ---------------------------------------------------------- |
| `src/`       | React web app (client-first UI and crypto)                |
| `convex/`    | Convex backend: schema, queries, mutations, actions       |
| `contracts/` | Solidity smart contracts                                  |
| `circuits/`  | ZK circuits and verifiers                                 |
| `cli/`       | `pampalo` command-line tooling                            |
| `sdk/`       | TypeScript SDK                                            |
| `shared/`    | Code shared across packages                              |
| `docs/`      | Architecture Decision Records (ADRs) and design docs      |
| `docs-site/` | Documentation site (published to docs.pampalo.com)        |
| `public/`    | Static assets and branding                               |

## Getting started

> Requires [pnpm](https://pnpm.io) and a [Convex](https://convex.dev) account.

```bash
pnpm install        # install dependencies
pnpm dev            # run Convex + web app (vite on :3000)
```

Other useful scripts:

```bash
pnpm test           # vitest + hardhat contract tests
pnpm lint           # eslint
pnpm format         # prettier + eslint --fix
pnpm pampalo        # run the CLI
```

## Roadmap

- **WebAuthn `largeBlob` extension as a second non-PRF fallback.** When a
  passkey provider doesn't expose PRF (notably 1Password on iOS as of mid
  2026), Pampalo currently falls back to a passphrase-protected wallet.
  `largeBlob` would let us store a random key inside the credential itself —
  no passphrase prompt, syncs with the passkey across the user's devices, and
  keeps the "magic, single-step" UX. The `largeBlob` flow would replace the
  passphrase-derived KEK with a randomly generated DEK stored in the
  credential's `largeBlob` slot. See [`AUTH.md`](./AUTH.md) §3 / §6 for
  context on the current envelope scheme. Worth revisiting once 1Password's
  `largeBlob` support is solid on iOS Safari.

## License

[MIT](./LICENSE) © Pampalo Pty Ltd

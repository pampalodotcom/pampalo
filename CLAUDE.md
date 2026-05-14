# Project brief

**This project is client-first.** With the user's configured passkey, they
can store anything in the Convex database — **but it must be encrypted**.

Concretely:

- The server (Convex) holds only ciphertext and public material. A full
  database leak should not reveal any user's mnemonic, transaction inputs,
  notes, or any other private data.
- Encryption keys are derived client-side from the user's passkey
  (preferred: WebAuthn PRF; fallback: ethers' passphrase-encrypted JSON
  keystore). The server never sees plaintext keys or the values needed to
  derive them.
- Any new field added to a Convex table that holds user data must either
  be (a) public by intent (EVM address, public keys, opaque counters), or
  (b) encrypted on the client before being written. There is no "trusted
  server" middle ground.
- New mutations and queries should be designed assuming the server is
  hostile: never accept plaintext that could be encrypted client-side
  instead, never return decryptable data, and gate writes on the session
  token (which is itself opaque, not a JWT carrying claims).
- See `AUTH.md` for the canonical encryption / passkey architecture.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

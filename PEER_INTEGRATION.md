# Integrating Peer (ZKP2P) into Pampalo — feasibility & TLS-notary/TEE notes

> Research note, 2026-05-29. Answers the question: *"To add a
> [peer.xyz](https://peer.xyz) fiat on/off-ramp to Pampalo, do we have to
> run our own TLS notary, and does it have to be a TEE?"*
>
> Short answer: **No, you don't have to run a notary at all to ship a
> first integration** — Peer hosts the notary, the proxy, and the
> attestation service, and you integrate against them via a redirect or a
> client SDK. You'd only stand up your own notary if you want to remove
> Peer as a trusted third party, and **even then a TEE is optional**
> (it's a trust-minimisation upgrade, not a correctness requirement for
> the MPC-TLS / TLSNotary primitive). The harder question for Pampalo is
> not the notary — it's what the **proxy** and **attestation service**
> get to see, because that's where this protocol brushes up against our
> privacy invariant.
>
> Sourcing caveat: `docs.peer.xyz` (incl. the redirect-onramp guide you
> linked) returns HTTP 403 to automated fetches, so the specifics below
> are reconstructed from Peer/ZKP2P search snippets, the public GitHub
> repos, and the TLSNotary docs. Anything tagged **(confirm)** should be
> double-checked against the live docs before we commit to an
> architecture.

---

## 1. What Peer / ZKP2P actually is

Peer (formerly ZKP2P) is a **trust-minimised P2P fiat on-ramp / off-ramp
protocol**. The model:

1. A liquidity provider (off-ramper) escrows crypto in an on-chain
   contract (V3 escrow, on **Base**) with an intent predicate like
   *"release $X of USDC to whoever proves they sent me $X on Venmo"*.
2. A buyer (on-ramper) creates an order; the matching escrow is locked
   for a window.
3. The buyer pays **fiat off-chain** through a normal payment app
   (Venmo, Revolut, Wise, Cash App, Zelle, MercadoPago, … — the
   supported set lives in [`zkp2p/providers`](https://github.com/zkp2p/providers)).
4. The buyer generates a **zkTLS "web proof"** that the payment really
   happened, by re-loading the payment provider's own confirmation page
   inside the **PeerAuth** browser extension / mobile appclip.
5. The proof is validated and the escrow releases crypto to the buyer's
   EVM address.

So in Pampalo terms this is a **funding rail**, not a privacy primitive:
it puts ERC-20 into a user's **public EVM balance**. It lives next to
"Receive/Deposit," upstream of `shield(...)`. It does *not* touch notes,
the merkle tree, the Poseidon identifier, or the mnemonic vault.

## 2. The moving parts (and who runs each today)

| Component | Role | Who hosts it today |
|---|---|---|
| **Escrow contracts** (V3) | Lock/release crypto on a payment predicate | On Base; Peer-deployed |
| **PeerAuth extension / appclip** | Generates the zkTLS web proof **client-side** | Runs on the user's device |
| **zkTLS proof provider** | The cryptographic primitive that makes the TLS session portable | Vendor-agnostic: **TLSNotary** (MPC-TLS), **Reclaim** & **Primus** (proxy-TLS), zkEmail |
| **WebSocket proxy** | Forwards (still-encrypted) TLS traffic between prover and the payment server | **Peer-hosted** |
| **Notary** | Co-signs the session transcript so the proof is portable | **Peer-hosted** |
| **Attestation service** | Parses/verifies the zkTLS proof and emits an **EIP-712 `PaymentAttestation`** the verifier contract checks | **Peer-hosted** backend |
| **Client SDK** | `@zkp2p/zkp2p-client-sdk` (browser-first on-ramp), `@zkp2p/offramp-sdk` (deposit/liquidity mgmt) | npm; runs in your app |

Key fact for your question: **"Currently ZKP2P runs both the Notary and
the WebSocket proxy."** A normal integration consumes those as a service.

## 3. The three integration tiers

### Tier A — Redirect on-ramp (the link you sent)
You redirect the user to Peer's hosted on-ramp flow; they complete fiat
payment + proof there and return with crypto in their EVM address. **You
host nothing crypto-specific** — no notary, no proxy, no attestation
service, no contracts. This is the fastest path to "fund your Pampalo
wallet with fiat." *(confirm exact redirect params / callback against the
linked guide once docs are reachable.)*

### Tier B — Embedded client SDK
`@zkp2p/zkp2p-client-sdk` runs the order/escrow/proof flow inside
Pampalo's own UI. Users still use the PeerAuth extension and **still rely
on Peer's hosted notary + proxy + attestation service**. More control
over UX; same trust dependencies as Tier A.

### Tier C — Self-hosted / headless
You stop depending on Peer's infra and run your own. *This* is the only
tier where the "run a notary / TEE" question is live. You would stand up:
- a **notary server** (TLSNotary, Rust),
- a **WebSocket proxy**,
- an **attestation service** (verifies proofs, signs the EIP-712 attestation),
- provider manifests for the payment apps you support,
- and point at (or redeploy) the escrow contracts on Base.

## 4. The notary & TEE question, answered precisely

The premise "I'd have to run my own TLS notary, and it would have to be a
TEE" conflates three separable decisions:

**(a) Do you need a notary at all?** No — not for Tiers A/B. Peer hosts
it. You'd run one only to drop Peer as a trusted party (Tier C).

**(b) If you self-host, must the notary be a TEE?** **No.** The relevant
trust property comes from the *primitive*, not the hardware:

- **MPC-TLS (TLSNotary).** The notary runs a 2-party-computation TLS
  handshake with the prover and **never sees plaintext** — only timing,
  byte lengths, round-trips, and the cipher suite. TLSNotary's own docs
  state the protocol *"does not have trust assumptions and does not rely
  on secure hardware or on the untamperability of the communication
  channel."* MPC is what stops the prover from forging a transcript. A
  TEE is **not** required for soundness.
- **Proxy-TLS (Reclaim / Primus).** A proxy/witness sits in the TLS path
  and attests to the ciphertext flow. Here the witness is more trusted,
  so TEE-style attestation carries more of the trust story.

**(c) So why would anyone TEE a notary?** To remove trust in the
*operator* (you). The residual risk in MPC-TLS is **notary–prover
collusion**: a malicious notary could in principle help a prover forge.
Two standard mitigations:
1. **TEE attestation** — run the TLSNotary `-sgx` build inside Intel SGX
   (the upstream path is Azure Confidential Computing). Verifiers/users
   can remotely attest the notary is running unmodified code, so they
   don't have to trust your good behaviour. Attestation is exposed at the
   server's `/<version>/info` endpoint.
2. **Multi-notary** — require the attestation to carry signatures from
   several independent notaries, so no single operator can collude.

For Pampalo specifically — a project whose entire posture is "assume the
server is hostile" — if we ever go Tier C, a **TEE-backed notary (or
multi-notary) is the philosophically consistent choice**, but it's a
trust-minimisation upgrade, not a gate on getting it working.

**TEE practicalities (Tier C only):**
- Upstream TLSNotary ships an SGX path on **Azure DCsv3 confidential
  VMs**. Other TEEs (AWS Nitro Enclaves, AMD SEV-SNP, Intel TDX) are
  conceivable but aren't the supported upstream build — budget real
  effort if you go off-path.
- Costs: confidential VMs are pricier than plain compute; you also own an
  enclave build/measurement pipeline and must ship client-side remote
  attestation verification.

## 5. Where this collides with Pampalo's privacy invariant

This is the part that matters more than the notary. Per `CONTEXT.md` /
`CLAUDE.md` / ADR-0001, the server stores *only* the encrypted mnemonic +
public WebAuthn material, and in-transit proxies may leak no more than
`(chainId, address)` (ADR-0004). Peer's components must be judged against
that bar:

- **The notary is fine.** It sees no plaintext (MPC-TLS). It's the
  cleanest component.
- **The proxy is a metadata leak.** It forwards encrypted traffic but
  **knows the destination host** — i.e. *which payment provider* the user
  is proving against (Venmo vs Revolut vs Zelle…), plus timing. That's
  strictly more than `(chainId, address)`. On Tiers A/B this metadata
  goes to **Peer**, a third party we don't control.
- **The attestation service is the sharp edge.** To emit the EIP-712
  `PaymentAttestation` it has to **see the extracted payment fields**
  (amount, currency, the payee handle / payment ID). That is exactly the
  category of plaintext financial data our invariant says must never
  touch a server we treat as trusted. **(confirm)** what it ingests and
  whether it persists anything — this single question should drive the
  build/host decision.
- **On-chain linkage is acceptable *if ordered correctly*.** The escrow
  releases to the user's **public EVM address** (`msg.sender`-style
  identity). That's the public handle by design, so an on-ramp landing in
  the *public* balance is consistent — provided the UX makes clear the
  on-ramp is public and routes the user into a subsequent `shield(...)`
  (with the standard shield wait) before any privacy is expected. An
  on-ramp does **not** and cannot create a shielded note directly.
- **Mnemonic vault is untouched.** PeerAuth, the notary, and the proxy
  never interact with the DEK/KEK/PRF layer. No change to AUTH.md scheme.

Net: zkTLS proof *generation* is client-side, which is on-brand for
Pampalo. The risk isn't the crypto — it's the **proxy + attestation
service as new trusted third parties** that see payment metadata. If that
matters for our threat model, it's an argument for **Tier C with
self-hosted, non-persisting infra** (and a TEE notary), not for avoiding
the notary.

## 6. What it would take — phased plan

**Phase 0 — Decide trust posture.** Confirm (against the live docs / the
team) exactly what Peer's proxy and attestation service see and persist
(§5). That answer picks the tier. *Cheapest correct default: ship Tier A,
label the on-ramp clearly as a public funding rail.*

**Phase 1 — Ship the on-ramp (Tier A or B).**
- Add a **"Fund with fiat"** option in the Receive/Deposit surface
  (`CONTEXT.md` "Receive"). Funds land in the **public** balance.
- Reuse the existing **shield-on-arrival** prompt so the user can move
  the on-ramped funds into a note after the shield wait.
- Tier A: a redirect + return handler. Tier B: integrate
  `@zkp2p/zkp2p-client-sdk`; users install/trigger PeerAuth.
- Route any on-chain reads through the `RpcClient` indirection in
  `src/lib/rpc.ts` (ADR-0004), not a new bespoke proxy.

**Phase 2 — (Only if §0/§5 demand independence) Self-host (Tier C).**
- Stand up the TLSNotary **notary** — `-sgx` build on Azure confidential
  compute for verifiable attestation (or run **multi-notary** as the
  non-TEE collusion mitigation).
- Stand up the **WebSocket proxy** and an **attestation service** that
  verifies proofs and signs the EIP-712 attestation **without persisting
  payment plaintext** (treat it as hostile-by-default infra, same as the
  rest of our backend).
- Maintain **provider manifests** ([`zkp2p/providers`](https://github.com/zkp2p/providers))
  for the payment apps we support.
- Point at / redeploy the V3 escrow contracts on Base
  ([`zkp2p/zkp2p-contracts`](https://github.com/zkp2p/zkp2p-contracts)).
- This is materially more ops (TEE pipeline, attestation verification,
  liquidity) and probably warrants its own ADR.

## 7. Open questions to confirm against live docs

1. Redirect on-ramp callback contract — params, signed return, how funds
   land. *(the page you linked, currently 403 to fetchers)*
2. Exactly what the **attestation service** ingests and whether it
   persists payment data — the decisive privacy question (§5).
3. Whether Peer supports a **bring-your-own-notary / self-host** config
   without redeploying the whole stack (partial Tier C).
4. Which **proof provider** Peer defaults to for our target payment rails
   (MPC-TLS vs proxy-TLS changes the trust story in §4).
5. SDK licence / package status of `@zkp2p/zkp2p-client-sdk` and whether a
   browser extension dependency is acceptable for our UX.

---

### Sources
- [Peer Docs — The ZKP2P Protocol](https://docs.peer.xyz/protocol/zkp2p-protocol)
- [Peer Docs — ZKP2P intro](https://docs.peer.xyz/guides/introduction/zkp2p)
- [Peer Docs — Integrate redirect on-ramp](https://docs.peer.xyz/developer/integrate-zkp2p/integrate-redirect-onramp) (403 to automated fetch)
- [ZKP2P Docs — zkTLS](https://docs.zkp2p.xyz/developer/peerauth-extension/zktls)
- [ZKP2P Docs — Introducing V3](https://docs.zkp2p.xyz/blog/intro-zkp2p-v3)
- [zkp2p on GitHub](https://github.com/zkp2p) · [client SDK](https://github.com/zkp2p/zkp2p-client-sdk) · [contracts](https://github.com/zkp2p/zkp2p-contracts) · [providers](https://github.com/zkp2p/providers)
- [TLSNotary — notary server](https://tlsnotary.org/docs/notary_server/) · [Run a Notary Server](https://docs.tlsnotary.org/developers/notary_server.html) · [FAQ](https://tlsnotary.org/docs/faq/)
- [TLSNotary — notary-server dockerfile for TEE attestation (gist)](https://gist.github.com/maceip/5ecd781e2c28e7abddec900f1deff445)
- [zkTLS Explained — MPC-TLS vs proxy-TLS (Gate Learn)](https://www.gate.com/learn/articles/zk-tls-unlocking-crypto-consumer-apps/7509)
- [Multiparty Notaries for zkTLS — TACEO](https://core.taceo.io/articles/mpc-zktls/)

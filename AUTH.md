# Passkey-based Non-Custodial Wallet — Auth & Encryption Architecture

This document specifies the authentication and encryption architecture for a non-custodial crypto wallet built on Convex. The defining property is that **the server stores only ciphertext and public material**; even a full database compromise should not reveal any user's mnemonic.

## 1. Threat model and security posture

**Goals:**
- Server never sees plaintext mnemonics, private keys, or any material that can decrypt them.
- A full DB leak reveals only: opaque user IDs, credential IDs, WebAuthn public keys, random salts, random IVs, and AES-GCM ciphertexts.
- No PII is required to operate a wallet. Email, phone, etc. are optional and out of scope for v1.
- **Wallet public addresses are not stored.** Addresses are derivable from the mnemonic and would otherwise link a DB row to on-chain activity. May become opt-in user-controlled later (e.g. for a "view balances without unlocking" feature) but must never be the default.

**Non-goals (v1):**
- Server-side recovery (deliberately impossible).
- Cross-wallet identity / linking.
- Social recovery, MPC, Shamir, custodial backup. These are planned as later recovery integrations; v1 ships with mnemonic display only.

**Trust assumptions:**
- The client device's secure element / OS keychain is trusted to hold the WebAuthn credential.
- The browser's WebAuthn implementation is trusted.
- The user is trusted to safeguard the displayed mnemonic.

**Residual linkage we explicitly accept:**

- **The sessionToken is opaque but stable.** It does not encode `userId` or any PII (§4), but it is the same value for the lifetime of a session. Any privacy-preserving flow that accepts `sessionToken` as a request argument — notably the shielded-transfer relayer (Convex `transfers.relay` action) — is observable in Convex's transport-level request log as repeated calls bearing the same token. An adversary with read access to that log can cluster activity as "the same anonymous user did these N things" even without resolving token → userId, because no Pampalo-owned domain table stores that join. We deliberately accept this rather than mint per-call ephemeral tokens because:
  - The cluster is unlabeled. There is no on-chain identity attached unless a separate token → user table is written, and the relayer is specified to write none (no `(sessionToken | userId) → txHash` row anywhere). See §4 for which tables exist.
  - Per-call rotation would add a token-mint mutation per relayed transfer plus a one-shot-token table to manage, in exchange for breaking the cluster at the cost of additional surface and complexity.
  - The same cluster-by-token property already exists for ordinary shield broadcasts (which additionally carry the user's own EOA in the tx, a strictly stronger linkage). Hardening relays without also hardening shields would not move the privacy floor.
- **Convex's transport-level request log is outside our control.** We do not retain `user → txHash` mappings in any domain table we own, but Convex's own audit/log layer records the args supplied to every action call, including session tokens. Hardening below that layer would require a different runtime than Convex.

## 2. Core mechanism: PRF extension, not "encrypt with passkey"

Passkey private keys **sign**; they do not encrypt or decrypt. To get an encryption key out of a passkey, use the WebAuthn **PRF extension** (`hmac-secret` at the CTAP layer).

PRF properties:
- During a `get()` ceremony, the client passes a salt. The authenticator returns `HMAC(credentialSecret, salt)` — 32 deterministic bytes.
- The output is stable for a given (credential, salt) pair.
- The credential secret never leaves the authenticator.
- For synced passkeys (iCloud Keychain, Google Password Manager), the credential secret syncs alongside the credential, so the PRF output is the same on every device the passkey is available on.

**Never use the PRF output directly as an encryption key.** Run it through HKDF with a domain-separator `info` string. This lets us derive multiple keys for different purposes from the same PRF output later without re-prompting.

## 3. Envelope encryption (required from v1 even though v1 has one passkey)

Even if v1 ships with a single passkey per wallet, **implement envelope encryption from the start**. It costs nothing now and makes "add another passkey" / "rotate passkey" feasible without re-encrypting the mnemonic.

Structure:
- A random 32-byte **DEK** (data encryption key) is generated client-side at wallet creation. It encrypts the mnemonic once, with AES-256-GCM.
- For each registered passkey, the DEK is wrapped (encrypted) with a KEK derived from that passkey's PRF output via HKDF.
- The mnemonic ciphertext is stored once. The wrapped DEK is stored per credential.

To unlock: get assertion with PRF → HKDF → unwrap DEK → decrypt mnemonic.
To add a passkey: unlock with existing passkey (DEK in memory) → register new passkey → derive new KEK → wrap DEK with new KEK → store.

## 4. Data model (Convex)

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Stable account row. userId is an opaque random 16-byte value generated server-side.
  // No PII required. displayName is optional and shown in authenticator UI only.
  users: defineTable({
    userIdBytes: v.bytes(),     // 16 random bytes; used as WebAuthn user.id
    displayName: v.string(),    // user-chosen label, e.g. "Main wallet"; never an email
    createdAt: v.number(),
  }).index("by_userIdBytes", ["userIdBytes"]),

  // One row per wallet. Mnemonic encrypted with DEK once.
  // No public address is stored — addresses are derived from the mnemonic client-side
  // after unlock. Storing an address would link this row to on-chain activity and
  // weaken the "DB leak reveals nothing useful" property. May become opt-in later.
  wallets: defineTable({
    userId: v.id("users"),
    mnemonicCiphertext: v.bytes(), // AES-256-GCM(DEK, mnemonic)
    mnemonicIv: v.bytes(),         // 12 bytes
    createdAt: v.number(),
  }).index("by_userId", ["userId"]),

  // One row per registered passkey. Wraps the DEK with a KEK derived from this passkey's PRF.
  credentials: defineTable({
    userId: v.id("users"),
    walletId: v.id("wallets"),
    credentialId: v.bytes(),       // raw credential ID from authenticator
    publicKey: v.bytes(),          // COSE-encoded public key for signature verification
    counter: v.number(),           // signature counter; 0 if authenticator doesn't track
    transports: v.array(v.string()),
    prfSalt: v.bytes(),            // 32 random bytes; input to PRF
    wrappedDek: v.bytes(),         // AES-256-GCM(KEK, DEK)
    wrappedDekIv: v.bytes(),       // 12 bytes
    label: v.string(),             // user-facing, e.g. "iPhone", "YubiKey"
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_credentialId", ["credentialId"])
    .index("by_userId", ["userId"]),

  // Short-lived state during a registration ceremony.
  // Cleaned up by a scheduled function on expiry.
  pendingRegistrations: defineTable({
    userIdBytes: v.bytes(),
    challenge: v.bytes(),
    expiresAt: v.number(),
  }).index("by_userIdBytes", ["userIdBytes"]),

  // Short-lived challenges for authentication ceremonies.
  pendingAuthentications: defineTable({
    challenge: v.bytes(),
    expiresAt: v.number(),
  }).index("by_challenge", ["challenge"]),

  // Session tokens after successful authentication.
  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
  }).index("by_token", ["token"]),
});
```

**What is NOT in the database:**
- Mnemonic phrase (plaintext)
- DEK (plaintext)
- KEK (plaintext)
- PRF output
- Any user PII

**Indexes:** `credentials.by_credentialId` is the hot path on every sign-in. `pendingRegistrations.by_userIdBytes` and `pendingAuthentications.by_challenge` are used to verify and consume one-time state.

## 5. Cryptography details

All client-side, using `crypto.subtle` (WebCrypto).

- **Mnemonic generation:** `ethers.Wallet.createRandom()`, 12-word BIP39 default. Capture `wallet.mnemonic.phrase`. Derive `wallet.address` only for ephemeral UI needs (e.g. download filename, confirmation screen) — never persist it.
- **DEK:** 32 random bytes from `crypto.getRandomValues`. Imported as AES-GCM-256 key.
- **Mnemonic encryption:** AES-256-GCM, 12-byte random IV, no AAD.
- **PRF salt:** 32 random bytes per credential. Different salt per credential is fine (and recommended); the same DEK is wrapped under different KEKs.
- **KEK derivation:** HKDF-SHA256 over the PRF output.
  - `salt`: empty
  - `info`: ASCII `"wallet-v1-kek"` (bump the version if the scheme changes)
  - Output: 32-byte AES-GCM key, non-extractable, usages `["encrypt", "decrypt"]`.
- **DEK wrapping:** AES-256-GCM with a fresh 12-byte IV. Store IV alongside the wrapped DEK.

Use non-extractable keys wherever possible. The DEK must be extractable (we re-wrap it when adding passkeys); the KEK should not be.

## 6. Flows

### 6.1 Account creation + first passkey

```
1. Client: user clicks "Create wallet."
2. Client → Convex mutation `startRegistration(displayName)`:
   - Generate userIdBytes (16 random bytes).
   - Generate challenge (32 random bytes).
   - Insert pendingRegistrations row with expiresAt = now + 5 min.
   - Return { userIdBytes, challenge, rp: { id, name } }.
3. Client: call navigator.credentials.create({
     publicKey: {
       rp, user: { id: userIdBytes, name: "", displayName },
       challenge,
       pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
       authenticatorSelection: { residentKey: "required", userVerification: "required" },
       extensions: { prf: {} }
     }
   }).
4. Client: verify result.getClientExtensionResults().prf?.enabled === true.
   - If false, abort with a clear error. PRF is required.
5. Client: call navigator.credentials.get({
     publicKey: {
       challenge: freshChallenge,
       allowCredentials: [{ id: credential.rawId, type: "public-key" }],
       extensions: { prf: { eval: { first: prfSalt } } }
     }
   }) to derive the PRF output.
6. Client: HKDF(prfOutput, info="wallet-v1-kek") → KEK.
7. Client: generate DEK (32 bytes). Generate mnemonic via ethers.
8. Client: AES-GCM-encrypt mnemonic with DEK → (mnemonicCiphertext, mnemonicIv).
9. Client: AES-GCM-encrypt DEK with KEK → (wrappedDek, wrappedDekIv).
10. Client → Convex mutation `completeRegistration(...)`:
    - Verify attestation (using @simplewebauthn/server or equivalent).
    - Verify challenge matches an unexpired pendingRegistrations row.
    - In a single transaction: insert users, wallets, credentials; delete pendingRegistrations.
    - Issue session token.
11. Client: the recovery phrase is NOT displayed during registration (see §10 —
    backup is nudged post-signup via the wallet-home banner, not gated here).
12. Client: derive the wallet address from the mnemonic via ethers (`wallet.address`).
13. Client: zero out the mnemonic, DEK, KEK, and prfOutput. **Do not retain the DEK.**
    Cache the encrypted blob in client-side memory for per-tx unlocking — see §6.6.
    Cached fields: { credentialId, prfSalt, mnemonicCiphertext, mnemonicIv,
    wrappedDek, wrappedDekIv }. The derived address can be retained in React state
    for display purposes.
14. Client: navigate to the authenticated wallet view (§7), showing the derived address.
```

**Critical ordering:** encrypt and store *before* displaying the mnemonic. If anything fails, the user has not been shown a phrase for a wallet that doesn't exist.

### 6.2 Sign in / unlock

```
1. Client → Convex mutation `startAuthentication()`:
   - Generate challenge (32 bytes), insert pendingAuthentications row, return challenge.
2. Client: call navigator.credentials.get({
     mediation: "conditional",  // for the first-visit case with autofill
     publicKey: {
       challenge,
       allowCredentials: [],     // discoverable credentials
       userVerification: "required",
       extensions: { prf: { eval: { first: <salt from server lookup, see note> } } }
     }
   }).
   - NOTE on salt: at this point we don't yet know the credentialId, so we don't know which
     prfSalt to use. There are two viable strategies:
       (a) Two-phase: get() WITHOUT prf first, server returns prfSalt for that credential,
           then get() AGAIN with prf eval. Costs a second UV prompt — bad UX.
       (b) Use a deterministic global salt (e.g. SHA-256("wallet-v1-prf-salt")). The PRF
           output is still per-credential, so this is safe; we just give up per-credential
           salt rotation. This is the recommended default.
     Choose (b) for v1. Store the same global salt in every credentials row for forward
     compatibility, or omit prfSalt entirely and recompute the constant.
3. Client → Convex mutation `verifyAuthentication(assertion)`:
   - Look up credential by credentialId.
   - Verify signature over (authData || SHA256(clientDataJSON)) with stored publicKey.
   - Verify challenge matches an unexpired pendingAuthentications row; consume it.
   - Update counter and lastUsedAt.
   - Issue session token; return { credentialId, prfSalt, wrappedDek, wrappedDekIv,
     mnemonicCiphertext, mnemonicIv }.
4. Client: HKDF(prfOutput, info="wallet-v1-kek") → KEK.
5. Client: AES-GCM-decrypt wrappedDek with KEK → DEK.
6. Client: AES-GCM-decrypt mnemonicCiphertext with DEK → mnemonic.
7. Client: derive the wallet address from the mnemonic via ethers (`wallet.address`).
8. Client: zero out the mnemonic, DEK, KEK, and prfOutput. **Do not retain the DEK.**
   Cache the encrypted blob in client-side memory for per-tx unlocking — see §6.6.
   The derived address can be retained in React state for display purposes.
9. Client: navigate to the authenticated wallet view (§7).
```

### 6.3 Add another passkey (requires existing session)

```
1. Client: must currently have an unlocked DEK in memory (i.e. user signed in this session).
2. Client → Convex mutation `startAddCredential()`:
   - Verify session.
   - Return existing userIdBytes, fresh challenge, list of existing credentialIds for
     excludeCredentials.
3. Client: navigator.credentials.create({ ..., excludeCredentials, extensions: { prf: {} } }).
4. Client: get() to derive PRF output (same as 6.1 step 5).
5. Client: HKDF → new KEK. Wrap existing in-memory DEK with new KEK → (wrappedDek, iv).
6. Client → Convex mutation `completeAddCredential(...)`:
   - Verify attestation, insert credentials row.
```

`excludeCredentials` makes the authenticator refuse to create a duplicate credential on a device that already holds one for this account — preventing the silent-overwrite failure from the conversation that produced this spec.

### 6.4 Sign out

```
1. Client: user clicks "Sign out."
2. Client → Convex mutation `signOut()`:
   - Look up the session row by token; delete it.
   - Idempotent: if the row is already gone, succeed silently.
3. Client: clear all in-memory secrets — DEK, derived signing keys, cached mnemonic if any.
   Best-effort: set variables to null, drop references held by React state, etc.
4. Client: clear the session token from its storage (cookie or localStorage).
5. Client: navigate to the unauthenticated landing page (showing "Sign in" and "Create wallet").
```

The server-side session delete is the authoritative sign-out. Client-side memory clearing is defence in depth — even if the page stays open, an attacker who later gains access to the tab shouldn't find usable key material.

### 6.5 Sign in entry point with conditional-UI safety net

The unauthenticated landing page has two buttons: **Sign in** and **Get started**. A background WebAuthn ceremony runs on page load so users with an existing synced passkey on this device are routed to sign-in regardless of which button they intended to tap. This is the primary mechanism for preventing duplicate wallet creation.

**On page load:**

1. Feature-detect: `await PublicKeyCredential.isConditionalMediationAvailable()`. If false (some Firefox configurations, older Safari builds), skip steps 2–3 and rely on the buttons alone.
2. Generate a challenge via §6.2 step 1 (`startAuthentication` mutation).
3. Kick off a background WebAuthn ceremony with conditional mediation:

```ts
const ac = new AbortController();
navigator.credentials.get({
  signal: ac.signal,
  mediation: "conditional",
  publicKey: {
    challenge,
    rpId,
    allowCredentials: [],            // discoverable credentials only
    userVerification: "required",
    extensions: { prf: { eval: { first: globalPrfSalt } } },
  },
}).then(handleSignInAssertion).catch(handleAbortOrFailure);
```

4. Add `autocomplete="username webauthn"` to any visible text input. iOS and Android often surface a system sheet at page load without requiring input focus; desktop browsers typically need focus on the tagged input. A styled "Account name (optional)" input is fine as an anchor — leave it blank for the user to ignore. Omit it entirely if you'd rather the page have no form; the iOS/Android sheet still works.

**If the conditional ceremony resolves** (user picked a synced passkey suggestion):
- Continue to §6.2 step 3 (`verifyAuthentication`) with the returned assertion. Sign-in completes without either button being tapped.

**Sign in button tap:**

1. `ac.abort()` to cancel the pending conditional ceremony. Browsers reject overlapping WebAuthn calls; aborting first is required.
2. Fire a new `get()` with `mediation: "optional"` and the same PRF extension parameters. This opens the platform's modal passkey picker immediately rather than waiting for autofill focus.
3. On resolve, proceed to §6.2 step 3.
4. On rejection (`NotAllowedError` is the common outcome for "no credentials" or "user cancelled"): show a non-blocking message such as "No passkeys available on this device. Tap **Get started** to create one, or sign in from a device that has your passkey." Do NOT auto-route to the creation flow — the user might have intended to use a different device or to plug in a security key.

**Get started button tap:**

1. `ac.abort()` to cancel any pending conditional ceremony.
2. Route to the creation flow (§6.1).
3. Honest UX: tapping Get started always creates a new wallet, even if a passkey exists on this device. The conditional ceremony from page load is the duplicate-prevention safety net; Get started itself is unambiguous "make me a new wallet." If you want belt-and-suspenders, the page Get started routes to can fire one more `get()` with `mediation: "optional"` before showing the creation UI — but this adds a passkey prompt to a flow the user clearly intended for creation, and the page-load conditional ceremony has already covered the synced-passkey case.

**AbortController hygiene:**

- One controller per page session; recreate on route changes or after each consumed ceremony.
- Always `ac.abort()` before starting a new ceremony, even when the previous one looks idle.
- Distinguish `AbortError` from real errors in `handleAbortOrFailure`. Aborts are expected and should not surface as user-visible failures.
- Conditional ceremonies do not consume the challenge; if the user ignores the suggestion and taps a button, the new ceremony needs a fresh challenge (a new `startAuthentication` call).

**Conditional UI feature gaps:**

- `isConditionalMediationAvailable()` returning false: skip the background ceremony, rely on buttons. No functional degradation, just the loss of the autofill-suggestion path.
- Safari on iOS surfaces the conditional sheet aggressively on page load; consider this when deciding whether to render a username input (the sheet can be confusing if there's no input nearby for the user to mentally anchor on).
- The `prf` extension during conditional `get()` works on the same authenticators as non-conditional; no separate compatibility matrix.

### 6.6 Sign a write transaction

Used for any state-changing operation: ETH transfers, ERC-20/721 calls, arbitrary contract method calls. Read-only RPC calls (balance fetches, view methods) do not use this flow.

**Every write transaction requires a fresh passkey prompt.** The DEK and mnemonic do not live in memory between signings.

```
1. App constructs the transaction object (to, value, data, nonce, gasLimit, maxFeePerGas,
   maxPriorityFeePerGas, chainId, type) via ethers.
2. App shows a confirmation modal: human-readable summary of what's being signed
   (recipient, amount, contract name + method if known, estimated gas cost, chain).
   The browser's passkey prompt cannot carry custom text, so this modal is where the
   user actually consents to the operation.
3. On user confirmation, call signAndSend(tx):
   a. Read the cached encrypted blob from the in-memory keystore.
      If absent (e.g. after page reload with a still-valid session), fetch via an
      authenticated Convex query `getEncryptedBlob()` — see §6.7.
   b. Generate a fresh challenge: 32 bytes from crypto.getRandomValues. NO server
      round-trip is needed for this challenge — the WebAuthn ceremony here is purely
      for PRF key derivation, not for authenticating to our server. The PRF output
      itself is the security primitive; we never verify the assertion server-side
      for signing operations.
   c. navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: credentialId, type: "public-key" }],
          userVerification: "required",
          extensions: { prf: { eval: { first: prfSalt } } }
        }
      }).
   d. Extract prfOutput from assertion.getClientExtensionResults().prf.results.first.
   e. HKDF(prfOutput, info="wallet-v1-kek") → KEK.
   f. AES-GCM-decrypt wrappedDek with KEK → DEK.
   g. AES-GCM-decrypt mnemonicCiphertext with DEK → mnemonic.
   h. ethers.Wallet.fromPhrase(mnemonic) → wallet instance with signing key.
   i. signedTx = await wallet.signTransaction(tx).
   j. In a finally block: zero all of prfOutput, KEK, DEK, mnemonic, wallet instance.
      Use try/finally to guarantee cleanup even on signing error.
   k. Broadcast signedTx via your RPC provider (alchemy, infura, public RPC).
   l. Return the tx hash.
```

**No server involvement during signing.** This is deliberate:
- The server does not need to verify the assertion; the PRF output never reaches it.
- Each signing is one local WebAuthn call + a few crypto ops + a broadcast — fast and offline-capable (the broadcast is the only network dep).
- Convex sessions are only consumed when the blob is fetched (once after sign-in, plus rare refetches after page reload).

**Where the cached blob lives:**
- v1: in-memory only. A module-scoped object or a Zustand/Jotai store outside the React tree. Not React state — React state ends up in devtools snapshots and Error Boundary props.
- On hard refresh, the blob is gone; fetch it again via §6.7 if the session token is still valid.
- Do NOT persist the blob in localStorage or IndexedDB in v1. Even though it's ciphertext, persisting weakens server-side session revocation: a user who signed out elsewhere could still trigger a passkey prompt and sign txs using leftover client state.
- sessionStorage is borderline acceptable (survives reload, dies on tab close) but adds complexity for limited gain; recommend skipping for v1.

**Memory hygiene per signing:**
- Wrap the entire decrypt-sign-cleanup sequence in try/finally with cleanup in finally.
- Set all key material variables to `null` after use. JS doesn't expose direct memory wiping, but dropping references gives GC a chance.
- Never log a tx object after signing — the `r`, `s`, `v` fields reveal nothing about the private key, but the discipline of "never log signed payloads" prevents future mistakes.
- Do not store the ethers Wallet instance anywhere; create it inside the signing function and let it fall out of scope.

**Confirmation modal UX:**
- For native ETH transfers: show amount, recipient (with checksum/ENS resolution if available), gas estimate.
- For contract calls with a known ABI: show the method name and decoded parameters.
- For unknown calldata: show the raw selector + a clear warning ("unverified contract call"). Consider blocking by default and requiring an explicit override.

### 6.7 Refetch encrypted blob

Called when the in-memory blob is missing but the session token is still valid (typical after a hard refresh).

```
1. Client → Convex query `getEncryptedBlob()`:
   - Require valid session token.
   - Look up the user's wallet + credentials.
   - Return { credentialId, prfSalt, mnemonicCiphertext, mnemonicIv, wrappedDek, wrappedDekIv }
     for the credential matching the session (or all credentials, letting the client pick).
2. Client: populate the in-memory keystore.
```

This is a query, not a mutation: it doesn't modify state and can be called freely. Convex will subscribe the client to updates so if the user adds a passkey from another tab, the blob list refreshes automatically.

## 7. Authenticated wallet view

After §6.1 or §6.2 completes successfully, the user lands on the authenticated wallet view. Minimum contents for v1:

- The wallet's **public address** (derived from the mnemonic during sign-in, then held in React state). Display in full and provide a copy button. The mnemonic itself is no longer in memory at this point — the address survives because it's a derived public value.
- A QR code of the address (optional, nice for receiving).
- A **Sign out** button that triggers §6.4.
- An "Add another passkey" entry point that triggers §6.3 (recommended; helps users add recovery).
- Any write actions (Send, Swap, contract interactions) — each triggers the §6.6 signing flow, which prompts the passkey.

The mnemonic is never displayed during registration (§6.1). The **only** place it is ever shown is the "Export recovery phrase" flow (Account page, or the wallet-home backup banner's CTA) — a separate flow that triggers §6.6's decrypt path but displays the recovery phrase instead of signing. See §10.

State management note:
- **In React state (safe):** derived public address, list of credential labels/metadata, UI state.
- **In a module-scoped keystore (not React state):** the cached encrypted blob.
- **Never persisted, never in React state:** mnemonic, DEK, KEK, prfOutput, private keys, ethers Wallet instances. These exist only transiently inside §6.6.

## 8. Cookies and client-side storage

Three distinct things can live in the browser; they have very different roles and should not be conflated.

### 8.1 Session token (httpOnly cookie, set by Convex)

The session token issued by §6.1 / §6.2 belongs in an httpOnly cookie set by the server during the HTTP action that verifies the WebAuthn ceremony.

- `httpOnly: true` — JS cannot read it. An XSS payload cannot exfiltrate it.
- `Secure: true` — only transmitted over HTTPS.
- `SameSite=Strict` — not sent on cross-site requests. Defeats CSRF.
- `Max-Age` — tied to the session expiry stored in the `sessions` table; reissue/extend on activity.
- `Path=/`.

Convex pattern: use an **HTTP action** (not a mutation) for `verifyAuthentication` and `completeRegistration` so the response can carry `Set-Cookie`. On subsequent page loads, a bootstrap HTTP action reads the cookie, validates against `sessions`, and hands the client a token suitable for `ConvexReactClient.setAuth()` (or use Convex's auth integration if it fits). Mutations and queries continue over WebSocket as normal once auth is established.

Alternative: store the token in localStorage and pass it explicitly to Convex. Works, but XSS can steal it. For a wallet, the httpOnly integration is worth it.

### 8.2 Device-has-account hint (regular cookie, set by Convex)

A non-sensitive flag set when an account is first created on this device (or when the user signs in successfully on a previously-unknown device). Purpose: let the unauthenticated landing page decide whether to lead with **Sign in** or **Create wallet**.

- Name: `wallet_known_device` (or similar).
- Value: `1`. No meaningful payload, no user identifier — it's a boolean.
- `httpOnly: false` — the landing page client reads it.
- `Secure: true`, `SameSite=Lax`.
- `Max-Age`: long, e.g. 1 year. This is a UX hint, not a credential.

Behaviour:
- **Set** on `completeRegistration` success AND on any successful `verifyAuthentication` from a device that didn't have the cookie (covers users who clear cookies but still have a passkey in their OS keychain).
- **Do NOT clear** on sign-out (§6.4). Signing out doesn't change the fact that this device has an account here — the next visit should still lead with "Sign in."
- **Do clear** on explicit account deletion or via a "Not your device?" link on the landing page that resets to a clean unknown-device state.

UX outcome: known devices see "Sign in" as the primary action and "Create new wallet" as secondary; unknown devices see the reverse. Reduces accidental duplicate-wallet creation.

### 8.3 The encrypted blob is NOT stored persistently

The blob (`credentialId`, `prfSalt`, `mnemonicCiphertext`, `mnemonicIv`, `wrappedDek`, `wrappedDekIv`) is held in a module-scoped JS object after sign-in. It is fetched via §6.7 on demand. It must NOT live in localStorage, sessionStorage, IndexedDB, or a cookie.

**The confidentiality argument is not the point.** The blob is ciphertext. Even if an attacker reads it from localStorage via XSS, disk forensics, or backup recovery, they cannot decrypt it without the passkey's PRF output, which never leaves the authenticator. So persistence is not a confidentiality leak.

**The reasons it's still bad are about availability and revocation:**

1. **Credential revocation stops working.** A user removes a passkey from settings ("I lost my old phone"). The server deletes that `credentials` row. With an in-memory blob fetched per session, the next sign-in attempt for that revoked credential fails — server enforcement holds. With the blob in localStorage, that device still has a valid `(prfSalt, wrappedDek)` paired with a still-functional OS-level passkey, and since §6.6 signing never round-trips to the server, the device can keep signing transactions indefinitely. The server has no enforcement point during signing. Revocation becomes a lie.

2. **Session revocation stops working.** Same mechanism. The act of signing in is what authorises a device to hold the blob; persistence converts that into "authorised once → authorised forever." Sign-out from another device, admin-forced sign-out, or session expiry all become unenforceable for write operations.

3. **Account deletion stops working.** "Delete my wallet" can wipe server rows, but cannot reach into localStorage on every device the user ever signed in from. Persisted blobs make deletion partial in a way users won't expect.

4. **Multi-user / shared browser profiles.** A blob in localStorage belongs to whoever opens the tab, not to the user who put it there. Not a confidentiality leak (the second user lacks the passkey) but a confusing UX failure mode where User B's login surfaces User A's encrypted wallet.

5. **No reactive freshness.** Convex's `getEncryptedBlob()` query (§6.7) is reactive — if the user adds or removes a passkey from another tab/device, the in-memory blob updates automatically. localStorage caches grow stale silently.

**sessionStorage is not a meaningful compromise.** It dies on tab close, but survives reloads, which is the only thing it buys you. For per-tx UV (§6.6), the reload case is rare and a single Convex query is cheap. The complexity isn't worth the marginal UX gain, and points 1–4 above still apply during the tab's lifetime.

**In-memory pattern:**

```ts
// keystore.ts — module-scoped, outside the React tree
type EncryptedBlob = {
  credentialId: ArrayBuffer;
  prfSalt: ArrayBuffer;
  mnemonicCiphertext: ArrayBuffer;
  mnemonicIv: ArrayBuffer;
  wrappedDek: ArrayBuffer;
  wrappedDekIv: ArrayBuffer;
};

let keystore: EncryptedBlob | null = null;
export const setKeystore = (b: EncryptedBlob) => { keystore = b; };
export const getKeystore = () => keystore;
export const clearKeystore = () => { keystore = null; };
```

On hard refresh `keystore` is `null`; if the session cookie is still valid, fetch via §6.7. If not, the user signs in again (which is cheap — one passkey prompt).

### 8.4 Sign-out cleanup checklist

§6.4 clears:
- The session-token cookie (server responds with `Set-Cookie: ...; Max-Age=0`).
- The in-memory keystore (`clearKeystore()`).
- React state holding the derived address and any UI bound to auth.

§6.4 does NOT clear:
- The device-has-account hint cookie (§8.2).
- The OS-level passkey itself — that lives in iCloud Keychain / Google Password Manager / Windows Hello and is not the app's to remove.

## 9. PRF feature detection and platform support (as of May 2026)

- **Required at registration time:** check `cred.getClientExtensionResults().prf?.enabled === true`. If false, the authenticator cannot do PRF and registration must be aborted. The wallet cannot function without PRF.
- **Apple platform authenticators (iOS 18+, macOS 15+):** supported.
- **Google Password Manager (Android, Chrome on desktop):** supported.
- **Windows Hello:** supported on Windows 11 25H2 with the February 2026 cumulative update (build 26200.7840+) and later.
- **YubiKeys / roaming authenticators on iOS/iPadOS Safari:** PRF extension data is NOT passed through. Detect this and either route the user to add a platform authenticator instead, or have them register from a different OS. Document this in the UI.
- **Firefox:** PRF support is incomplete; treat as unsupported and show a "use Chrome/Safari/Edge" message.

Implement a pre-flight detection step before any wallet creation flow: try a throwaway `create()` + `get()` with a test challenge and check `prf.enabled` + `prf.results.first`. If either is missing, show a clear "your browser or device can't run this wallet" page rather than letting the user proceed and fail mid-creation.

## 10. Recovery phrase display UX

- **Signup never displays the recovery phrase.** Registration completes and the user lands directly on the wallet home. The synced passkey (iCloud Keychain / Google Password Manager) is the primary recovery mechanism; the recovery phrase is the escape hatch. (This supersedes the earlier "reveal + type-three-words confirmation, don't accept skip" design — the confirmation was soft-gated in practice and added friction without an enforceable guarantee.)
- **Backup banner:** the wallet home shows a "Back up your recovery phrase" banner until the wallet is backed up. Its CTA launches the export flow directly (passkey ceremony → decrypt → reveal). Dismissing the banner (X) hides it for the current session only.
- **Backed up** means: the user completed an export and clicked Copy or Download. This sets `mnemonicBackedUpAt` inside the **encrypted preferences blob** (never a plaintext server column — backup status linked to a wallet row would violate the privacy invariant). The field is monotonic: sync merges take `max(upstream, local)` regardless of the dirty flag, so a stale device can never un-back-up a wallet.
- The export flow is the **only** surface that displays the phrase:
  - Reveal only after a successful passkey ceremony decrypts the mnemonic.
  - Default state: blurred panel with "Tap to reveal."
  - Provide three actions: Reveal, Copy, Download as `.txt`.
  - Download filename: `wallet-recovery-<first6CharsOfAddress>.txt` with content as the 12 words separated by spaces, plus a one-line header `# Recovery phrase for 0xABC123…`.
  - Clipboard hygiene: after `Copy`, set a 60-second timer to overwrite clipboard with an empty string. Wrap in try/catch — some browsers reject programmatic clipboard writes after delays.
  - Do not screenshot-block. It's unreliable on web; just suggest writing offline.
- Future: a one-click cloud backup integration (e.g. Google Drive / Microsoft) as the low-friction backup path. Unscoped; whatever ships must upload only client-side-encrypted material, per the privacy invariant.
- Never log the mnemonic. No `console.log`, no Sentry breadcrumb that includes form state, no analytics event with values. Treat the variable as radioactive: minimum scope, overwrite to `null` immediately after use.

## 11. Convex-specific concerns

- **Idempotency:** `completeRegistration` and `completeAddCredential` must be safe to retry. Enforce a uniqueness constraint on `credentialId` (use a unique index; on conflict, return the existing row rather than error if the credentialId already exists for the same user — otherwise error).
- **Pending row cleanup:** schedule a recurring function (e.g. `crons.interval("clean pending", { minutes: 5 }, internal.auth.cleanupPending)`) that deletes `pendingRegistrations` and `pendingAuthentications` rows where `expiresAt < now`.
- **Session expiry:** sessions table should also be cleaned up; check expiry on every authenticated mutation.
- **Server-side WebAuthn verification:** use `@simplewebauthn/server`. Convex functions are V8 isolates; verify it runs there or wrap the verification in a Convex action (Node runtime) rather than a mutation. The split is:
  - `action` for verification (Node, can use full crypto / `@simplewebauthn/server`).
  - `mutation` for the actual DB writes, called from the action after verification succeeds.

## 12. Libraries

- **Client:** `@simplewebauthn/browser` for the `create()` / `get()` wrappers (handles base64url encoding correctly). `ethers` for wallet/mnemonic generation. WebCrypto built-ins for AES-GCM and HKDF.
- **Server (Convex action):** `@simplewebauthn/server` for attestation/assertion verification.

## 13. Out of scope for v1 (explicitly)

- Recovery integrations (cloud backup, social recovery, Shamir). The mnemonic-on-paper flow is the only recovery in v1.
- Multiple wallets per account. One user → one wallet → many passkeys.
- Server-side transaction signing or any operation that requires the server to hold key material.
- Email / SMS / OTP. No identity contact channels in v1.
- Sign-in via username/email. Discoverable credentials only; the authenticator's account picker is the username step.

## 14. Open questions for the implementer

- Decide between TanStack React Start, Next.js, or another React framework for the client. The auth flow is framework-agnostic; the spec above doesn't constrain this.
- Decide which chain(s) to support and RPC providers (alchemy, infura, public RPC) for broadcasting signed txs. The §6.6 signing flow is chain-agnostic at the WebAuthn/crypto layer; tx construction and broadcast is where chain-specific decisions live.
- Confirm the PRF feature detection page copy with design before shipping; "your device can't run this wallet" is a hard message and needs to land softly.
- Decide how to handle calldata decoding in the §6.6 confirmation modal: full ABI lookup (4byte.directory, sourcify), known-contract registry, or raw selector + warning. Affects user safety on unverified contract interactions.

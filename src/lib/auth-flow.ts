// High-level WebAuthn / envelope-encryption flows:
//
// - registerNewWallet: AUTH.md §6.1 (account creation + first passkey).
//   Returns the freshly generated mnemonic so the caller can show the
//   confirmation UX. Once the user confirms, call `finalizeNewWallet` to
//   derive + persist the address.
// - signIn: AUTH.md §6.2 (sign-in). Returns the derived address.
// - signOut: AUTH.md §6.4. Hits the /auth/signout HTTP route.
// - bootstrapFromCookie: AUTH.md §6.5 / §6.7 — used on page load.

import { Wallet } from 'ethers'
import type { HDNodeWallet } from 'ethers'
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveKekFromPrfOutput,
  generateDekBytes,
  importDekBytes,
  zeroBytes,
} from './crypto'
import { deriveAddresses } from './derive-addresses'
import type { DerivedAddresses } from './derive-addresses'
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  utf8ToBuffer,
  bufferToUtf8,
} from './encoding'
import { postJson } from './http'
import {
  clearAll,
  getBlob,
  setAddresses,
  setBlob,
  setSessionToken,
} from './keystore'
import type { EncryptedBlob } from './keystore'
import {
  extractPrfFirst,
  prfEnabledOnRegistration,
  runGetForPrf,
  runRegistrationCeremony,
} from './passkey'
import { Timing } from './timing'

// ─── Typed errors for compatibility failures ─────────────────────────────
// These are recognised by the Landing route to switch into a help UI state
// instead of just toasting a string.

export class PrfNotSupportedError extends Error {
  readonly kind = 'prf-not-supported' as const
  constructor() {
    super(
      'Your passkey provider doesn’t support the encryption extension Pampalo needs.',
    )
    this.name = 'PrfNotSupportedError'
  }
}

export class UnknownCredentialError extends Error {
  readonly kind = 'unknown-credential' as const
  constructor() {
    super(
      'The passkey you picked isn’t registered with Pampalo on this account.',
    )
    this.name = 'UnknownCredentialError'
  }
}

// ─── Wire types matching convex/http.ts ──────────────────────────────────

type RegStartRes = {
  userIdBytes: string
  challenge: string
  rpId: string
  rpName: string
}
type RegCompleteRes = { sessionToken: string; expiresAt: number }
type AuthStartRes = { challenge: string; rpId: string }
type AuthCompleteRes = { sessionToken: string; expiresAt: number }
type BootstrapRes = {
  sessionToken: string
  sessionExpiresAt: number
  wallet: {
    mnemonicCiphertext: string
    mnemonicIv: string
  }
  credentials: Array<{
    credentialId: string
    wrappedDek: string
    wrappedDekIv: string
  }>
}

// ─── Registration ────────────────────────────────────────────────────────

export type NewWalletDraft = {
  mnemonic: string
  addresses: DerivedAddresses
  sessionToken: string
}

export async function registerNewWallet(): Promise<NewWalletDraft> {
  // 1. Generate wallet locally. The WebAuthn user record only carries a
  //    static "Pampalo" label — the OS keychain disambiguates by
  //    credential id / creation time.
  const dekBytes = generateDekBytes()
  const wallet = Wallet.createRandom()
  const mnemonic = wallet.mnemonic?.phrase
  if (!mnemonic) throw new Error('ethers did not return a mnemonic')
  const addresses = deriveAddresses(wallet)
  const passkeyDisplayName = 'Pampalo'

  // 2. Server start (records the random userIdBytes + challenge).
  const start = await postJson<Record<string, never>, RegStartRes>(
    '/auth/registration/start',
    {},
  )

  // 3. Browser create(). We don't gate on prf.enabled here — iOS Safari +
  //    1Password routinely signal enabled:false / undefined on create
  //    even when the credential will happily produce PRF output on a
  //    subsequent get(). We log the value for diagnostics but always
  //    proceed to the get() and let *its* result decide.
  const attestation = await runRegistrationCeremony(start, passkeyDisplayName)
  console.log(
    '[pampalo:auth] register: create() prf.enabled =',
    prfEnabledOnRegistration(attestation),
  )

  // 4. Browser get() to actually derive PRF output. This is the
  //    authoritative capability check. PRF-less providers are rejected
  //    here — there is no passphrase fallback. See ADR 0002.
  const fakeChallengeForPrf = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  )
  const { prfOutput } = await runGetForPrf({
    challenge: fakeChallengeForPrf,
    rpId: start.rpId,
    allowCredentialId: attestation.id,
  })
  console.log(
    '[pampalo:auth] register: get() prfOutput =',
    prfOutput ? 'present' : 'null',
  )
  if (!prfOutput) {
    throw new PrfNotSupportedError()
  }

  let kek: CryptoKey | null = null
  let dekKey: CryptoKey | null = null
  let mnemonicCiphertext: ArrayBuffer | null = null
  let mnemonicIv: ArrayBuffer | null = null
  let wrappedDek: ArrayBuffer | null = null
  let wrappedDekIv: ArrayBuffer | null = null

  try {
    kek = await deriveKekFromPrfOutput(prfOutput)
    dekKey = await importDekBytes(dekBytes, false)

    const enc = await aesGcmEncrypt(dekKey, utf8ToBuffer(mnemonic))
    mnemonicCiphertext = enc.ciphertext
    mnemonicIv = enc.iv

    const wrapped = await aesGcmEncrypt(kek, dekBytes)
    wrappedDek = wrapped.ciphertext
    wrappedDekIv = wrapped.iv

    const completeBody = {
      userIdBytes: start.userIdBytes,
      attestation,
      walletPayload: {
        mnemonicCiphertext: bufferToBase64Url(mnemonicCiphertext),
        mnemonicIv: bufferToBase64Url(mnemonicIv),
        wrappedDek: bufferToBase64Url(wrappedDek),
        wrappedDekIv: bufferToBase64Url(wrappedDekIv),
      },
    }
    const complete = await postJson<typeof completeBody, RegCompleteRes>(
      '/auth/registration/complete',
      completeBody,
    )

    return {
      mnemonic,
      addresses,
      sessionToken: complete.sessionToken,
    }
  } finally {
    zeroBytes(dekBytes)
    kek = null
    dekKey = null
    mnemonicCiphertext = null
    mnemonicIv = null
    wrappedDek = null
    wrappedDekIv = null
    void kek
    void dekKey
    void mnemonicCiphertext
    void mnemonicIv
    void wrappedDek
    void wrappedDekIv
  }
}

export function finalizeNewWallet(draft: NewWalletDraft): void {
  // Mnemonic is intentionally NOT cached. The blob is repopulated via
  // /auth/bootstrap on the next page navigation.
  setSessionToken(draft.sessionToken)
  setAddresses(draft.addresses)
}

// ─── Sign in ─────────────────────────────────────────────────────────────

export type SignInOutcome = {
  addresses: DerivedAddresses
  sessionToken: string
}

export async function signInWithExistingPasskey(): Promise<SignInOutcome> {
  const t = new Timing('sign-in')
  // 1. Server start.
  console.log('→ POST /auth/authentication/start')
  const start = await postJson<Record<string, never>, AuthStartRes>(
    '/auth/authentication/start',
    {},
  )
  console.log('← /auth/authentication/start')

  // 2. Browser get() with PRF, no allowCredentials → discoverable picker.
  // This is the user-interaction step — Face ID / Touch ID / passkey picker.
  console.log('→ navigator.credentials.get() (PRF)')
  const { assertion, prfOutput } = await runGetForPrf({
    challenge: start.challenge,
    rpId: start.rpId,
  })
  console.log('← navigator.credentials.get()')

  // 3. Server verify.
  console.log('→ POST /auth/authentication/complete')
  let complete: AuthCompleteRes
  try {
    complete = await postJson<
      { assertion: typeof assertion },
      AuthCompleteRes
    >('/auth/authentication/complete', { assertion })
  } catch (e) {
    if (e instanceof Error && /unknown credential/i.test(e.message)) {
      throw new UnknownCredentialError()
    }
    throw e
  }
  console.log('← /auth/authentication/complete')

  // 4. Bootstrap to discover protection scheme, then branch.
  const outcome = await unlockAfterAssertion(prfOutput, complete.sessionToken, t)
  t.finish()
  return outcome
}

// ─── Conditional-UI handler ──────────────────────────────────────────────
// When a conditional-mediation get() resolves on its own (autofill/sheet),
// we still need to verify and unlock. Same shape as signInWithExistingPasskey
// but the assertion came from the conditional ceremony.

export async function completeConditionalSignIn(
  assertion: AuthenticationResponseJSON,
): Promise<SignInOutcome> {
  const prfOutput = extractPrfFirst(assertion)
  let complete: AuthCompleteRes
  try {
    complete = await postJson<
      { assertion: typeof assertion },
      AuthCompleteRes
    >('/auth/authentication/complete', { assertion })
  } catch (e) {
    if (e instanceof Error && /unknown credential/i.test(e.message)) {
      throw new UnknownCredentialError()
    }
    throw e
  }
  return await unlockAfterAssertion(prfOutput, complete.sessionToken)
}

// ─── Re-auth (unlock-only, no new session) ───────────────────────────────
// After a hard refresh, the bootstrap call repopulates the encrypted blob
// in the keystore but the mnemonic / address are gone. This runs a passkey
// ceremony purely to derive PRF and decrypt — no server round-trip for
// auth, since the cookie is still valid.

export type ReAuthOutcome = { addresses: DerivedAddresses }

export async function reAuthenticate(): Promise<ReAuthOutcome> {
  const t = new Timing('re-auth')
  const blob = getBlob()
  if (!blob) {
    // Blob hasn't been bootstrapped yet — fall back to full sign-in.
    console.log('no blob → fallback to full sign-in')
    t.finish('fallback')
    const outcome = await signInWithExistingPasskey()
    return { addresses: outcome.addresses }
  }

  const cred = blob.credentials[0]

  // Local-only challenge: the PRF derivation runs entirely in the
  // authenticator + browser; the server never sees this assertion.
  const localChallenge = bufferToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  )
  const credentialIdB64 = bufferToBase64Url(cred.credentialId)
  console.log('→ navigator.credentials.get() (PRF, local challenge)')
  const { prfOutput } = await runGetForPrf({
    challenge: localChallenge,
    rpId: rpIdHint(),
    allowCredentialId: credentialIdB64,
  })
  console.log('← navigator.credentials.get()')
  if (!prfOutput) {
    throw new PrfNotSupportedError()
  }

  console.log('HKDF: derive KEK from PRF output')
  const kek = await deriveKekFromPrfOutput(prfOutput)
  console.log('AES-GCM: unwrap DEK')
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv)
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false)
  console.log('AES-GCM: decrypt mnemonic')
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    blob.mnemonicCiphertext,
    blob.mnemonicIv,
  )
  const mnemonic = bufferToUtf8(mnemonicBuf)
  console.log('mnemonic decoded')

  let wallet: HDNodeWallet | null = null
  try {
    wallet = Wallet.fromPhrase(mnemonic)
    console.log('ethers.Wallet.fromPhrase()')
    const addresses = deriveAddresses(wallet)
    console.log('deriveAddresses (EVM + envelope + poseidon)')
    setAddresses(addresses)
    console.log('keystore + localStorage updated')
    t.finish()
    return { addresses }
  } finally {
    new Uint8Array(dekBytes).fill(0)
    new Uint8Array(mnemonicBuf).fill(0)
    wallet = null
  }
}

// rpId for the get() ceremony. We don't have the value from the server in
// the re-auth path; falls back to the current hostname which is correct
// for both `localhost` and prod domains.
function rpIdHint(): string {
  if (typeof window === 'undefined') return 'localhost'
  return window.location.hostname
}

// ─── Sign out ────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  try {
    await postJson<Record<string, never>, { ok: true }>('/auth/signout', {})
  } finally {
    clearAll()
  }
}

// ─── Bootstrap from cookie (page load) ───────────────────────────────────
// Returns null if no valid session. On success, populates the in-memory
// keystore (without unlocking) and returns the session token. The address
// is NOT set yet; that happens on the next §6.6 unlock or via signIn.

export async function bootstrapFromCookie(): Promise<{
  sessionToken: string
  blob: EncryptedBlob
} | null> {
  try {
    const res = await postJson<Record<string, never>, BootstrapRes>(
      '/auth/bootstrap',
      {},
    )
    const blob: EncryptedBlob = {
      mnemonicCiphertext: base64UrlToBuffer(res.wallet.mnemonicCiphertext),
      mnemonicIv: base64UrlToBuffer(res.wallet.mnemonicIv),
      credentials: res.credentials.map((c) => ({
        credentialId: base64UrlToBuffer(c.credentialId),
        wrappedDek: base64UrlToBuffer(c.wrappedDek),
        wrappedDekIv: base64UrlToBuffer(c.wrappedDekIv),
      })),
    }
    setBlob(blob)
    setSessionToken(res.sessionToken)
    return { sessionToken: res.sessionToken, blob }
  } catch (e) {
    if (
      e instanceof Error &&
      (e as Error & { status?: number }).status === 401
    ) {
      return null
    }
    throw e
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

async function unlockAfterAssertion(
  prfOutput: ArrayBuffer | null,
  sessionToken: string,
  parentTiming?: Timing,
): Promise<SignInOutcome> {
  const t = parentTiming ?? new Timing('unlock')

  console.log('→ POST /auth/bootstrap')
  const boot = await bootstrapFromCookie()
  if (!boot) throw new Error("Server didn't accept the freshly issued cookie")
  console.log('← /auth/bootstrap')

  setSessionToken(sessionToken)

  if (!prfOutput) {
    throw new PrfNotSupportedError()
  }
  const cred = boot.blob.credentials[0]

  console.log('HKDF: derive KEK from PRF output')
  const kek = await deriveKekFromPrfOutput(prfOutput)
  console.log('AES-GCM: unwrap DEK')
  const dekBytes = await aesGcmDecrypt(kek, cred.wrappedDek, cred.wrappedDekIv)
  const dekKey = await importDekBytes(new Uint8Array(dekBytes), false)
  console.log('AES-GCM: decrypt mnemonic')
  const mnemonicBuf = await aesGcmDecrypt(
    dekKey,
    boot.blob.mnemonicCiphertext,
    boot.blob.mnemonicIv,
  )
  const mnemonic = bufferToUtf8(mnemonicBuf)
  console.log('mnemonic decoded')

  let wallet: HDNodeWallet | null = null
  try {
    wallet = Wallet.fromPhrase(mnemonic)
    console.log('ethers.Wallet.fromPhrase()')
    const addresses = deriveAddresses(wallet)
    console.log('deriveAddresses (EVM + envelope + poseidon)')
    setAddresses(addresses)
    console.log('keystore + localStorage updated')
    if (!parentTiming) t.finish()
    return { addresses, sessionToken }
  } finally {
    // Best-effort scrub.
    new Uint8Array(dekBytes).fill(0)
    new Uint8Array(mnemonicBuf).fill(0)
    wallet = null
  }
}

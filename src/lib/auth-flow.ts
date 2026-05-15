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
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'
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
  getGlobalPrfSalt,
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
    protectionScheme: 'prf' | 'passphrase'
    mnemonicCiphertext: string | null
    mnemonicIv: string | null
    encryptedJson: string | null
    mnemonicConfirmedAt: number | null
  }
  credentials: Array<{
    credentialId: string
    prfSalt: string | null
    wrappedDek: string | null
    wrappedDekIv: string | null
    label: string
  }>
}

// ─── Registration ────────────────────────────────────────────────────────

export type NewWalletDraft = {
  mnemonic: string
  addresses: DerivedAddresses
  sessionToken: string
}

// On PRF failure we don't throw — we return everything the second-step
// passphrase flow needs so the user only ever sees one OS passkey prompt.
export type PassphraseSetupContext = {
  attestation: RegistrationResponseJSON
  userIdBytes: string
  rpId: string
  // The wallet has already been generated client-side; we hold it here
  // until the user supplies a passphrase to encrypt it. Mnemonic lives in
  // memory only for the duration of this object.
  mnemonic: string
  addresses: DerivedAddresses
}

export type RegistrationOutcome =
  | { kind: 'success'; draft: NewWalletDraft }
  | { kind: 'needs-passphrase'; ctx: PassphraseSetupContext }

export async function registerNewWallet(
  _unusedLabel?: string,
): Promise<RegistrationOutcome> {
  // 1. Generate wallet locally; nothing about it leaks into the WebAuthn
  //    user record (label is just "Pampalo" — the OS keychain disambiguates
  //    by credential id / creation time).
  const dekBytes = generateDekBytes()
  const wallet = Wallet.createRandom()
  const mnemonic = wallet.mnemonic?.phrase
  if (!mnemonic) throw new Error('ethers did not return a mnemonic')
  const addresses = deriveAddresses(wallet)
  const passkeyDisplayName = 'Pampalo'

  // 2. Server start (records the random userIdBytes + challenge).
  const start = await postJson<{ displayName: string }, RegStartRes>(
    '/auth/registration/start',
    { displayName: passkeyDisplayName },
  )

  // 3. Browser create(). We don't gate on prf.enabled here — iOS Safari +
  //    1Password (and some other providers) routinely signal
  //    enabled:false / undefined on create even when the credential will
  //    happily produce PRF output on a subsequent get(). We log the value
  //    for diagnostics but always proceed to the get() and let *its*
  //    result decide whether we have a usable PRF or need to fall back.
  const attestation = await runRegistrationCeremony(start, passkeyDisplayName)
  console.log(
    '[pampalo:auth] register: create() prf.enabled =',
    prfEnabledOnRegistration(attestation),
  )

  // 4. Browser get() to actually derive PRF output. This is the
  //    authoritative capability check.
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
    // Credential genuinely doesn't support PRF on either ceremony — fall
    // back to passphrase. The passkey itself still works for
    // authentication (sign-in challenges); we just can't use it to
    // derive an encryption key.
    return {
      kind: 'needs-passphrase',
      ctx: {
        attestation,
        userIdBytes: start.userIdBytes,
        rpId: start.rpId,
        mnemonic,
        addresses,
      },
    }
  }

  let kek: CryptoKey | null = null
  let dekKey: CryptoKey | null = null
  let mnemonicCiphertext: ArrayBuffer | null = null
  let mnemonicIv: ArrayBuffer | null = null
  let wrappedDek: ArrayBuffer | null = null
  let wrappedDekIv: ArrayBuffer | null = null
  let saltCopy: Uint8Array | null = null

  try {
    kek = await deriveKekFromPrfOutput(prfOutput)
    dekKey = await importDekBytes(dekBytes, false)

    const enc = await aesGcmEncrypt(dekKey, utf8ToBuffer(mnemonic))
    mnemonicCiphertext = enc.ciphertext
    mnemonicIv = enc.iv

    const wrapped = await aesGcmEncrypt(kek, dekBytes)
    wrappedDek = wrapped.ciphertext
    wrappedDekIv = wrapped.iv

    // 5. Server complete.
    const saltAB = await getGlobalPrfSalt()
    saltCopy = new Uint8Array(saltAB.byteLength)
    saltCopy.set(new Uint8Array(saltAB))

    const completeBody = {
      userIdBytes: start.userIdBytes,
      attestation,
      walletPayload: {
        scheme: 'prf' as const,
        mnemonicCiphertext: bufferToBase64Url(mnemonicCiphertext),
        mnemonicIv: bufferToBase64Url(mnemonicIv),
        wrappedDek: bufferToBase64Url(wrappedDek),
        wrappedDekIv: bufferToBase64Url(wrappedDekIv),
        prfSalt: bufferToBase64Url(saltCopy),
        label: defaultPasskeyLabel(),
      },
    }
    const complete = await postJson<typeof completeBody, RegCompleteRes>(
      '/auth/registration/complete',
      completeBody,
    )

    // 6. Addresses are already derived above; surface them back to the caller.
    return {
      kind: 'success' as const,
      draft: {
        mnemonic,
        addresses,
        sessionToken: complete.sessionToken,
      },
    }
  } finally {
    // Best-effort wipe of in-memory key material. References to CryptoKey are
    // dropped; raw byte arrays are zeroed.
    zeroBytes(dekBytes, saltCopy ?? undefined)
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

// Second step of registration when PRF wasn't available. Takes the
// user-supplied passphrase, encrypts the wallet with ethers' scrypt-backed
// keystore format, and finishes registration with the server.
export async function completePassphraseRegistration(
  ctx: PassphraseSetupContext,
  passphrase: string,
): Promise<NewWalletDraft> {
  // Re-hydrate the wallet from the mnemonic so we can use ethers' encrypt.
  // (We never persist this — it stays in memory only for this function.)
  const wallet = Wallet.fromPhrase(ctx.mnemonic)
  const encryptedJson = await wallet.encrypt(passphrase)

  const completeBody = {
    userIdBytes: ctx.userIdBytes,
    attestation: ctx.attestation,
    walletPayload: {
      scheme: 'passphrase' as const,
      encryptedJson,
      label: defaultPasskeyLabel(),
    },
  }
  const complete = await postJson<typeof completeBody, RegCompleteRes>(
    '/auth/registration/complete',
    completeBody,
  )

  return {
    mnemonic: ctx.mnemonic,
    addresses: ctx.addresses,
    sessionToken: complete.sessionToken,
  }
}

// Unlock a passphrase-protected wallet using the user-supplied passphrase.
// Reads the encrypted JSON from the in-memory blob, decrypts via ethers,
// and updates the keystore/addresses. No passkey ceremony — the cookie
// session is the auth primitive; the passphrase is the encryption primitive.
export async function unlockWithPassphrase(
  passphrase: string,
): Promise<DerivedAddresses> {
  const t = new Timing('unlock-passphrase')
  // Make sure the blob is in memory. If it isn't (cold start), bootstrap.
  let blob = getBlob()
  if (!blob) {
    t.mark('→ POST /auth/bootstrap (cold)')
    const boot = await bootstrapFromCookie()
    if (!boot) throw new Error('Session expired — please sign in again.')
    blob = boot.blob
    t.mark('← /auth/bootstrap')
  }
  if (!blob.encryptedJson) {
    throw new Error('This wallet isn’t passphrase-protected.')
  }
  t.mark('Wallet.fromEncryptedJson (scrypt)')
  let wallet: HDNodeWallet | null = null
  try {
    const decrypted = await Wallet.fromEncryptedJson(
      blob.encryptedJson,
      passphrase,
    )
    // ethers may return a Wallet (private-key only) or an HDNodeWallet
    // (mnemonic + private key). We require the HD form for deriveAddresses.
    if (!('mnemonic' in decrypted) || !decrypted.mnemonic) {
      throw new Error('Decrypted wallet has no mnemonic.')
    }
    wallet = decrypted
    const addresses = deriveAddresses(wallet)
    t.mark('deriveAddresses (EVM + envelope + poseidon)')
    setAddresses(addresses)
    t.finish()
    return addresses
  } finally {
    wallet = null
  }
}

// Marks the wallet's mnemonic as confirmed server-side. Called when the
// user completes the 3-word confirmation step. Skipping ("Do it later")
// just doesn't call this; the wallet's mnemonicConfirmedAt stays null.
export async function markMnemonicConfirmed(
  sessionToken: string,
): Promise<void> {
  const { ConvexHttpClient } = await import('convex/browser')
  const { api } = await import('../../convex/_generated/api')
  const url = import.meta.env.VITE_CONVEX_URL as string | undefined
  if (!url) throw new Error('VITE_CONVEX_URL is not set')
  const client = new ConvexHttpClient(url)
  await client.mutation(api.auth.confirmMnemonic, { sessionToken })
}

// ─── Sign in ─────────────────────────────────────────────────────────────

// PRF wallets unlock end-to-end in one step. Passphrase wallets surface
// `needs-passphrase` so the UI can prompt for the passphrase as a second
// step — the cookie session is already established at that point.
export type SignInOutcome =
  | { kind: 'success'; addresses: DerivedAddresses; sessionToken: string }
  | { kind: 'needs-passphrase'; sessionToken: string }

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

// Thrown from `reAuthenticate` when the wallet is passphrase-protected — the
// re-auth path can't unlock without a passphrase prompt, so the caller (the
// wallet route) needs to switch to the passphrase entry UI instead.
export class PassphraseRequiredError extends Error {
  readonly kind = 'passphrase-required' as const
  constructor() {
    super('This wallet is passphrase-protected. Enter your passphrase to unlock.')
    this.name = 'PassphraseRequiredError'
  }
}

export type ReAuthOutcome =
  | { kind: 'success'; addresses: DerivedAddresses }
  | { kind: 'needs-passphrase' }

export async function reAuthenticate(): Promise<ReAuthOutcome> {
  const t = new Timing('re-auth')
  const blob = getBlob()
  if (!blob) {
    // Blob hasn't been bootstrapped yet — fall back to full sign-in.
    console.log('no blob → fallback to full sign-in')
    t.finish('fallback')
    const outcome = await signInWithExistingPasskey()
    if (outcome.kind === 'needs-passphrase') return { kind: 'needs-passphrase' }
    return { kind: 'success', addresses: outcome.addresses }
  }

  if (blob.protectionScheme === 'passphrase') {
    // No PRF available — caller must prompt for the passphrase.
    t.finish('passphrase')
    return { kind: 'needs-passphrase' }
  }

  const cred = blob.credentials[0]
  if (!cred.wrappedDek || !cred.wrappedDekIv) {
    throw new Error('PRF wallet missing wrapped DEK — re-sign in.')
  }
  if (!blob.mnemonicCiphertext || !blob.mnemonicIv) {
    throw new Error('PRF wallet missing mnemonic ciphertext — re-sign in.')
  }

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
    return { kind: 'success', addresses }
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
      protectionScheme: res.wallet.protectionScheme,
      mnemonicCiphertext: res.wallet.mnemonicCiphertext
        ? base64UrlToBuffer(res.wallet.mnemonicCiphertext)
        : null,
      mnemonicIv: res.wallet.mnemonicIv
        ? base64UrlToBuffer(res.wallet.mnemonicIv)
        : null,
      encryptedJson: res.wallet.encryptedJson,
      credentials: res.credentials.map((c) => ({
        credentialId: base64UrlToBuffer(c.credentialId),
        prfSalt: c.prfSalt ? base64UrlToBuffer(c.prfSalt) : null,
        wrappedDek: c.wrappedDek ? base64UrlToBuffer(c.wrappedDek) : null,
        wrappedDekIv: c.wrappedDekIv
          ? base64UrlToBuffer(c.wrappedDekIv)
          : null,
        label: c.label,
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

  // Refetch the encrypted blob via /auth/bootstrap (cookie now valid). This
  // also tells us whether the wallet is PRF- or passphrase-protected, which
  // we can't know from the assertion alone.
  console.log('→ POST /auth/bootstrap')
  const boot = await bootstrapFromCookie()
  if (!boot) throw new Error("Server didn't accept the freshly issued cookie")
  console.log('← /auth/bootstrap')

  setSessionToken(sessionToken)

  if (boot.blob.protectionScheme === 'passphrase') {
    // Cookie session is established; the UI now needs to ask the user for
    // their passphrase before we can derive addresses.
    if (!parentTiming) t.finish('passphrase')
    return { kind: 'needs-passphrase', sessionToken }
  }

  if (!prfOutput) {
    // Wallet is PRF-protected but this passkey didn't return PRF output.
    throw new PrfNotSupportedError()
  }
  const cred = boot.blob.credentials[0]
  if (!cred.wrappedDek || !cred.wrappedDekIv) {
    throw new Error('PRF wallet missing wrapped DEK — server state corrupt.')
  }
  if (!boot.blob.mnemonicCiphertext || !boot.blob.mnemonicIv) {
    throw new Error('PRF wallet missing mnemonic ciphertext — server state corrupt.')
  }

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
    return { kind: 'success', addresses, sessionToken }
  } finally {
    // Best-effort scrub.
    new Uint8Array(dekBytes).fill(0)
    new Uint8Array(mnemonicBuf).fill(0)
    wallet = null
  }
}

function defaultPasskeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Passkey'
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad/.test(ua)) return 'iPhone'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Passkey'
}

// WebAuthn helpers — registration + authentication ceremonies + PRF derivation.
// Uses @simplewebauthn/browser for base64url handling of WebAuthn payloads.

import {
  startAuthentication as swaStartAuthentication,
  startRegistration as swaStartRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { base64UrlToBuffer, utf8ToBuffer } from "./encoding";

// AUTH.md §6.2 note: per-credential salts are dropped in v1 in favour of
// a single deterministic global salt. This avoids the two-prompt UX of
// looking up a per-credential salt before deriving the PRF output.
//
// Using SHA-256 of an ASCII identifier — regenerated synchronously on first
// use (top-level `await` is avoided to keep the module SSR-safe).
let globalPrfSalt: ArrayBuffer | null = null;
export async function getGlobalPrfSalt(): Promise<ArrayBuffer> {
  if (globalPrfSalt) return globalPrfSalt;
  globalPrfSalt = await crypto.subtle.digest(
    "SHA-256",
    utf8ToBuffer("wallet-v1-prf-salt"),
  );
  return globalPrfSalt;
}

export type StartRegistrationServerOpts = {
  userIdBytes: string; // base64url
  challenge: string; // base64url
  rpId: string;
  rpName: string;
};

// Wraps swaStartRegistration with PRF + sane defaults from AUTH.md §6.1 step 3.
export async function runRegistrationCeremony(
  opts: StartRegistrationServerOpts,
  displayName: string,
): Promise<RegistrationResponseJSON> {
  return await swaStartRegistration({
    optionsJSON: {
      rp: { id: opts.rpId, name: opts.rpName },
      user: { id: opts.userIdBytes, name: displayName, displayName },
      challenge: opts.challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      // PRF isn't in the DOM lib AuthenticationExtensionsClientInputs typing yet.
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  });
}

export function prfEnabledOnRegistration(
  cred: RegistrationResponseJSON,
): boolean {
  const ext = cred.clientExtensionResults as
    | { prf?: { enabled?: boolean } }
    | undefined;
  return ext?.prf?.enabled === true;
}

// ─── PRF derivation via a get() ceremony ──────────────────────────────────

type AuthenticatorTransportLike =
  | "usb"
  | "nfc"
  | "ble"
  | "internal"
  | "hybrid"
  | "smart-card";

export async function runGetForPrf(opts: {
  challenge: string; // base64url
  rpId: string;
  allowCredentialId?: string; // base64url; required to scope to a specific cred
  // Transport hints for the credential — needed so the browser routes to
  // the local platform authenticator instead of the cross-device QR sheet
  // when allowCredentials is populated.
  allowCredentialTransports?: ReadonlyArray<string>;
}): Promise<{
  assertion: AuthenticationResponseJSON;
  prfOutput: ArrayBuffer | null;
}> {
  const salt = await getGlobalPrfSalt();

  const assertion = await swaStartAuthentication({
    optionsJSON: {
      challenge: opts.challenge,
      rpId: opts.rpId,
      allowCredentials: opts.allowCredentialId
        ? [
            {
              id: opts.allowCredentialId,
              type: "public-key",
              transports: opts.allowCredentialTransports as
                | AuthenticatorTransportLike[]
                | undefined,
            },
          ]
        : [],
      userVerification: "required",
      // PRF inputs are passed straight through to navigator.credentials.get
      // by @simplewebauthn/browser (it doesn't translate extension values),
      // so `first` must be an ArrayBuffer, not a base64url string.
      extensions: {
        prf: { eval: { first: salt } },
      } as unknown as AuthenticationExtensionsClientInputs,
    },
  });

  return { assertion, prfOutput: extractPrfFirst(assertion) };
}

export function extractPrfFirst(
  assertion: AuthenticationResponseJSON,
): ArrayBuffer | null {
  const ext = assertion.clientExtensionResults as
    | { prf?: { results?: { first?: string | ArrayBuffer } } }
    | undefined;
  const first = ext?.prf?.results?.first;
  if (!first) return null;
  if (typeof first === "string") return base64UrlToBuffer(first);
  return first;
}

// Re-export for convenience
export { swaStartAuthentication, swaStartRegistration };

// ─── Conditional UI controller ────────────────────────────────────────────

export async function isConditionalUIAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined") return false;
  const fn = (
    PublicKeyCredential as unknown as {
      isConditionalMediationAvailable?: () => Promise<boolean>;
    }
  ).isConditionalMediationAvailable;
  if (typeof fn !== "function") return false;
  try {
    return Boolean(await fn());
  } catch {
    return false;
  }
}

export async function startConditionalGet(opts: {
  challenge: string;
  rpId: string;
  signal: AbortSignal;
}): Promise<{
  assertion: AuthenticationResponseJSON;
  prfOutput: ArrayBuffer | null;
}> {
  const salt = await getGlobalPrfSalt();
  const assertion = await swaStartAuthentication({
    optionsJSON: {
      challenge: opts.challenge,
      rpId: opts.rpId,
      allowCredentials: [],
      userVerification: "required",
      // PRF inputs are passed straight through to navigator.credentials.get
      // by @simplewebauthn/browser (it doesn't translate extension values),
      // so `first` must be an ArrayBuffer, not a base64url string.
      extensions: {
        prf: { eval: { first: salt } },
      } as unknown as AuthenticationExtensionsClientInputs,
    },
    useBrowserAutofill: true,
  });
  // Older Safari versions ignore the AbortSignal on conditional get; this is
  // tracked but not actionable from JS. The signal is still wired in case the
  // browser respects it.
  if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
  const prfOutput = extractPrfFirst(assertion);
  return { assertion, prfOutput };
}

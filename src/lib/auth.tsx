// React provider that owns auth state.
//
// On mount it tries POST /auth/bootstrap. If a valid session cookie exists,
// it pulls the encrypted blob into the in-memory keystore. The mnemonic is
// NOT decrypted at this point — that requires a passkey prompt.
//
// Per AUTH.md §6.7 the encrypted blob also re-fetches reactively via the
// Convex `getEncryptedBlob` query so changes from another tab/device flow
// in. We keep the bootstrap-call result authoritative for first paint and
// then let the Convex subscription take over.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { base64UrlToBuffer } from "./encoding";
import {
  bootstrapFromCookie,
  reAuthenticate as runReAuthenticate,
  signOut as runSignOut,
} from "./auth-flow";
import type { DerivedAddresses } from "./derive-addresses";
import {
  clearAll,
  getAddresses,
  getSessionToken,
  setBlob,
  type EncryptedBlob,
} from "./keystore";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous"; knownDevice: boolean }
  | {
      status: "authenticated";
      sessionToken: string;
      addresses: DerivedAddresses | null;
    };

type AuthContextValue = {
  state: AuthState;
  refreshAddress: () => void;
  reAuth: () => Promise<DerivedAddresses>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readKnownDeviceCookie(): boolean {
  if (typeof document === "undefined") return false;
  return /(^|;\s*)wallet_known_device=1(;|$)/.test(document.cookie);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  // Bootstrap on mount.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const boot = await bootstrapFromCookie();
        if (ac.signal.aborted) return;
        if (!boot) {
          setState({
            status: "anonymous",
            knownDevice: readKnownDeviceCookie(),
          });
          return;
        }
        setState({
          status: "authenticated",
          sessionToken: boot.sessionToken,
          addresses: getAddresses(),
        });
      } catch {
        if (ac.signal.aborted) return;
        setState({
          status: "anonymous",
          knownDevice: readKnownDeviceCookie(),
        });
      }
    })();
    return () => {
      ac.abort();
    };
  }, []);

  // Reactive refresh of the encrypted blob via Convex (AUTH.md §6.7).
  const sessionToken =
    state.status === "authenticated" ? state.sessionToken : null;
  const blobQuery = useQuery(
    api.auth.getEncryptedBlob,
    sessionToken ? { sessionToken } : "skip",
  );
  useEffect(() => {
    if (!blobQuery) return;
    const blob: EncryptedBlob = {
      mnemonicCiphertext: base64UrlToBuffer(
        bufferToB64UrlIfNeeded(blobQuery.wallet.mnemonicCiphertext),
      ),
      mnemonicIv: base64UrlToBuffer(
        bufferToB64UrlIfNeeded(blobQuery.wallet.mnemonicIv),
      ),
      credentials: blobQuery.credentials.map((c) => ({
        credentialId: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.credentialId)),
        prfSalt: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.prfSalt)),
        wrappedDek: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.wrappedDek)),
        wrappedDekIv: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.wrappedDekIv)),
        label: c.label,
      })),
    };
    setBlob(blob);
  }, [blobQuery]);

  const value: AuthContextValue = {
    state,
    refreshAddress: () => {
      // Pull authoritative session + derived addresses from the keystore.
      // Used after registration / sign-in to promote the React state into
      // authenticated even if it was previously anonymous.
      const token = getSessionToken();
      const a = getAddresses();
      if (token) {
        setState({
          status: "authenticated",
          sessionToken: token,
          addresses: a,
        });
      } else {
        setState({
          status: "anonymous",
          knownDevice: readKnownDeviceCookie(),
        });
      }
    },
    reAuth: async () => {
      await runReAuthenticate();
      const a = getAddresses();
      const token = getSessionToken();
      if (token) {
        setState({
          status: "authenticated",
          sessionToken: token,
          addresses: a,
        });
      }
      if (!a) throw new Error("Addresses missing after re-auth");
      return a;
    },
    signOut: async () => {
      await runSignOut();
      clearAll();
      setState({ status: "anonymous", knownDevice: readKnownDeviceCookie() });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

// Convex query returns ArrayBuffer-shaped values when a v.bytes() column is
// fetched. The browser SDK delivers them as ArrayBuffer-like objects, but
// when bytes round-trip via Convex's v8 runtime they may surface as
// base64url strings (older runtime) OR as ArrayBuffer (newer). Normalize.
function bufferToB64UrlIfNeeded(value: ArrayBuffer | string): string {
  if (typeof value === "string") return value;
  const bytes = new Uint8Array(value);
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

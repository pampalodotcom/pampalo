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

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { base64UrlToBuffer } from "./encoding";
import {
  bootstrapFromCookie,
  reAuthenticate as runReAuthenticate,
  signOut as runSignOut,
  type ReAuthOutcome,
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
  reAuth: () => Promise<ReAuthOutcome>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// "Have we seen this browser before?" — used to decide whether the landing
// page shows "Sign in with Passkey" or "Get started". The Convex response
// sets a `wallet_known_device` cookie for this, but on iOS Safari with
// some passkey providers (notably 1Password) the cookie doesn't reliably
// survive the WebAuthn ceremony / Safari's storage caps, even though the
// user clearly registered. The `pampalo:addresses` localStorage key is
// written on every registration / unlock completion (`setAddresses` →
// keystore.writePersistedAddresses) and survives these quirks, so we OR
// it with the cookie check.
function readKnownDeviceSignal(): boolean {
  if (typeof document === "undefined") return false;
  if (/(^|;\s*)wallet_known_device=1(;|$)/.test(document.cookie)) return true;
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("pampalo:addresses")
    ) {
      return true;
    }
  } catch {
    /* localStorage disabled (private mode etc) — fall through */
  }
  return false;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  // Bootstrap on mount.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      // Diagnostic: dump what storage is visible on this device. Helps
      // debug iOS Safari + 1Password cookie loss without needing remote
      // tooling. Cheap and once-per-mount.
      if (typeof window !== "undefined") {
        const cookieKeys = (document.cookie || "")
          .split(";")
          .map((s) => s.trim().split("=")[0])
          .filter(Boolean);
        let lsKeys: Array<string> = [];
        try {
          lsKeys = Object.keys(window.localStorage).filter((k) =>
            k.startsWith("pampalo:"),
          );
        } catch {
          /* localStorage disabled (private mode etc) */
        }
        console.log("[pampalo:auth] visible storage", { cookieKeys, lsKeys });
      }
      try {
        const boot = await bootstrapFromCookie();
        if (ac.signal.aborted) return;
        if (!boot) {
          setState({
            status: "anonymous",
            knownDevice: readKnownDeviceSignal(),
          });
          return;
        }
        const cachedAddresses = getAddresses();
        // The bootstrap path reads addresses from localStorage without
        // going through setAddresses, so the per-wallet IDB scoping
        // (idb-notes, idb-sync-cursor) hasn't been bound yet. Bind
        // it here so the wallet UI doesn't transiently render data
        // from a different passkey's bucket. Dynamic import keeps the
        // notes module out of the bootstrap critical path.
        if (cachedAddresses?.evm) {
          void import("./idb-notes").then((m) =>
            m.setActiveWallet(cachedAddresses.evm),
          );
        }
        setState({
          status: "authenticated",
          sessionToken: boot.sessionToken,
          addresses: cachedAddresses,
        });
      } catch {
        if (ac.signal.aborted) return;
        setState({
          status: "anonymous",
          knownDevice: readKnownDeviceSignal(),
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
    api.auth.ceremony.getEncryptedBlob,
    sessionToken ? { sessionToken } : "skip",
  );
  useEffect(() => {
    if (!blobQuery) return;
    const w = blobQuery.wallet;
    const blob: EncryptedBlob = {
      mnemonicCiphertext: base64UrlToBuffer(
        bufferToB64UrlIfNeeded(w.mnemonicCiphertext),
      ),
      mnemonicIv: base64UrlToBuffer(bufferToB64UrlIfNeeded(w.mnemonicIv)),
      credentials: blobQuery.credentials.map((c) => ({
        credentialId: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.credentialId)),
        wrappedDek: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.wrappedDek)),
        wrappedDekIv: base64UrlToBuffer(bufferToB64UrlIfNeeded(c.wrappedDekIv)),
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
          knownDevice: readKnownDeviceSignal(),
        });
      }
    },
    reAuth: async () => {
      const outcome = await runReAuthenticate();
      const token = getSessionToken();
      if (token) {
        setState({
          status: "authenticated",
          sessionToken: token,
          addresses: outcome.addresses,
        });
      }
      return outcome;
    },
    signOut: async () => {
      await runSignOut();
      clearAll();
      setState({ status: "anonymous", knownDevice: readKnownDeviceSignal() });
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

import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const SESSION_COOKIE = "pampalo_session";
const KNOWN_DEVICE_COOKIE = "wallet_known_device";
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;
const KNOWN_DEVICE_MAX_AGE_S = 365 * 24 * 60 * 60;

// Comma-separated allowlist of client origins, e.g.
//   PAMPALO_ALLOWED_ORIGINS=http://localhost:3000,https://pampalo.app
function allowedOrigins(): Array<string> {
  const env = process.env.PAMPALO_ALLOWED_ORIGINS ?? "";
  return env
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
}

// WebAuthn requires the RP ID to match the browser's origin (or be a
// registrable suffix). If the request comes from localhost, no production
// RP ID will work — the browser refuses. So pick `localhost` when the
// caller is local, and require an explicit env var otherwise. Preview
// deployments without PAMPALO_RP_ID set will fail loudly on the first
// auth call — that's intentional.
function rpIdForRequest(req: Request): string {
  const origin = req.headers.get("Origin") ?? "";
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return "localhost";
    }
  } catch {
    /* empty/malformed Origin — fall through to env default */
  }
  const rpId = process.env.PAMPALO_RP_ID;
  if (!rpId) {
    throw new Error(
      "PAMPALO_RP_ID is not set on this Convex deployment. Set it to the registrable domain that serves the app (e.g. pampalo.com).",
    );
  }
  return rpId;
}

function corsHeaders(req: Request): HeadersInit {
  const reqOrigin = req.headers.get("Origin") ?? "";
  const allow = allowedOrigins();
  // If no allowlist is configured (dev mode), echo the request origin so
  // local Vite + Convex can talk to each other without env setup. In prod,
  // set PAMPALO_ALLOWED_ORIGINS to lock this down to your real domain(s).
  const origin =
    allow.length === 0
      ? reqOrigin
      : allow.includes(reqOrigin)
        ? reqOrigin
        : (allow[0] ?? "");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function jsonResponse(req: Request, body: unknown, init?: ResponseInit): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    ...corsHeaders(req),
    ...(init?.headers as Record<string, string> | undefined),
  });
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(req: Request, status: number, message: string): Response {
  return jsonResponse(req, { error: message }, { status });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq);
    if (key === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

function setCookie(name: string, value: string, opts: {
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  httpOnly?: boolean;
  secure?: boolean;
}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`SameSite=${opts.sameSite ?? "None"}`);
  if (opts.secure ?? true) parts.push("Secure");
  if (opts.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

const http = httpRouter();

// ─── CORS preflight (one handler covers all routes) ──────────────────────

const optionsHandler = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
});

const ROUTES: Array<string> = [
  "/auth/registration/start",
  "/auth/registration/complete",
  "/auth/authentication/start",
  "/auth/authentication/complete",
  "/auth/signout",
  "/auth/bootstrap",
];
for (const path of ROUTES) {
  http.route({ path, method: "OPTIONS", handler: optionsHandler });
}

// ─── Registration start ──────────────────────────────────────────────────

http.route({
  path: "/auth/registration/start",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const result: { userIdBytes: ArrayBuffer; challenge: ArrayBuffer } =
      await ctx.runMutation(internal.auth._startRegistration, {});
    return jsonResponse(req, {
      userIdBytes: arrayBufferToBase64Url(result.userIdBytes),
      challenge: arrayBufferToBase64Url(result.challenge),
      rpId: rpIdForRequest(req),
      rpName: process.env.PAMPALO_RP_NAME ?? "Pampalo",
    });
  }),
});

// ─── Registration complete ───────────────────────────────────────────────

http.route({
  path: "/auth/registration/complete",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    type Body = {
      userIdBytes: string;
      attestation: unknown;
      walletPayload: {
        mnemonicCiphertext: string;
        mnemonicIv: string;
        wrappedDek: string;
        wrappedDekIv: string;
      };
    };
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return errorResponse(req, 400, "invalid JSON");
    }

    let result: { sessionToken: string; expiresAt: number };
    try {
      const wp = body.walletPayload;
      result = await ctx.runAction(
        internal.authNode.verifyAndCompleteRegistration,
        {
          userIdBytes: base64UrlToArrayBuffer(body.userIdBytes),
          expectedRPID: rpIdForRequest(req),
          expectedOrigin:
            req.headers.get("Origin") ??
            (allowedOrigins()[0] ?? "http://localhost:3000"),
          attestation: body.attestation,
          walletPayload: {
            mnemonicCiphertext: base64UrlToArrayBuffer(wp.mnemonicCiphertext),
            mnemonicIv: base64UrlToArrayBuffer(wp.mnemonicIv),
            wrappedDek: base64UrlToArrayBuffer(wp.wrappedDek),
            wrappedDekIv: base64UrlToArrayBuffer(wp.wrappedDekIv),
          },
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "registration failed";
      return errorResponse(req, 400, msg);
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      ...corsHeaders(req),
    });
    headers.append(
      "Set-Cookie",
      setCookie(SESSION_COOKIE, result.sessionToken, {
        maxAge: SESSION_MAX_AGE_S,
        httpOnly: true,
        sameSite: "None",
        secure: true,
      }),
    );
    headers.append(
      "Set-Cookie",
      setCookie(KNOWN_DEVICE_COOKIE, "1", {
        maxAge: KNOWN_DEVICE_MAX_AGE_S,
        httpOnly: false,
        sameSite: "Lax",
        secure: true,
      }),
    );
    return new Response(
      JSON.stringify({
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
      }),
      { status: 200, headers },
    );
  }),
});

// ─── Authentication start ────────────────────────────────────────────────

http.route({
  path: "/auth/authentication/start",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const result: { challenge: ArrayBuffer } = await ctx.runMutation(
      internal.auth._startAuthentication,
      {},
    );
    return jsonResponse(req, {
      challenge: arrayBufferToBase64Url(result.challenge),
      rpId: rpIdForRequest(req),
    });
  }),
});

// ─── Authentication complete ─────────────────────────────────────────────

http.route({
  path: "/auth/authentication/complete",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    type Body = { assertion: unknown };
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return errorResponse(req, 400, "invalid JSON");
    }

    let result: { sessionToken: string; expiresAt: number };
    try {
      result = await ctx.runAction(
        internal.authNode.verifyAndCompleteAuthentication,
        {
          expectedRPID: rpIdForRequest(req),
          expectedOrigin:
            req.headers.get("Origin") ??
            (allowedOrigins()[0] ?? "http://localhost:3000"),
          assertion: body.assertion,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "authentication failed";
      return errorResponse(req, 401, msg);
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      ...corsHeaders(req),
    });
    headers.append(
      "Set-Cookie",
      setCookie(SESSION_COOKIE, result.sessionToken, {
        maxAge: SESSION_MAX_AGE_S,
        httpOnly: true,
        sameSite: "None",
        secure: true,
      }),
    );
    headers.append(
      "Set-Cookie",
      setCookie(KNOWN_DEVICE_COOKIE, "1", {
        maxAge: KNOWN_DEVICE_MAX_AGE_S,
        httpOnly: false,
        sameSite: "Lax",
        secure: true,
      }),
    );
    return new Response(
      JSON.stringify({
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
      }),
      { status: 200, headers },
    );
  }),
});

// ─── Sign out ────────────────────────────────────────────────────────────

http.route({
  path: "/auth/signout",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      await ctx.runMutation(internal.auth._deleteSessionByToken, { token });
    }
    const headers = new Headers({
      "Content-Type": "application/json",
      ...corsHeaders(req),
    });
    headers.append(
      "Set-Cookie",
      setCookie(SESSION_COOKIE, "", {
        maxAge: 0,
        httpOnly: true,
        sameSite: "None",
        secure: true,
      }),
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }),
});

// ─── Bootstrap (cookie → session token + blob) ───────────────────────────

http.route({
  path: "/auth/bootstrap",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return errorResponse(req, 401, "no session");
    const blob = await ctx.runQuery(internal.auth._bootstrapBlob, { token });
    if (!blob) return errorResponse(req, 401, "session invalid");
    return jsonResponse(req, {
      sessionToken: blob.sessionToken,
      sessionExpiresAt: blob.sessionExpiresAt,
      // Echo the rpId used at registration time so client-side ceremonies
      // (re-auth, export, sync) don't have to guess from
      // window.location.hostname — that breaks for apex-vs-www origins.
      rpId: rpIdForRequest(req),
      wallet: {
        mnemonicCiphertext: arrayBufferToBase64Url(blob.wallet.mnemonicCiphertext),
        mnemonicIv: arrayBufferToBase64Url(blob.wallet.mnemonicIv),
      },
      credentials: blob.credentials.map((c) => ({
        credentialId: arrayBufferToBase64Url(c.credentialId),
        wrappedDek: arrayBufferToBase64Url(c.wrappedDek),
        wrappedDekIv: arrayBufferToBase64Url(c.wrappedDekIv),
        // Transport hints so allowCredentials in get() can steer the
        // browser to the local platform authenticator instead of the
        // cross-device picker.
        transports: c.transports,
      })),
    });
  }),
});

export default http;

// ─── base64url helpers ───────────────────────────────────────────────────
// (Convex V8 runtime supports atob/btoa.)

function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToArrayBuffer(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

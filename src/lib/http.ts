// Thin wrapper around fetch() to call Convex HTTP actions with cookies.
//
// We always go through a same-origin proxy (vite.config.ts maps /_convex/*
// to the Convex .convex.site host). This keeps the session cookie first-
// party on the app's origin, avoiding browser third-party cookie blocking.

export function siteUrl(): string {
  return "/_convex";
}

export type ApiError = Error & { status: number };

export async function postJson<TReq extends object, TRes>(
  path: string,
  body: TReq,
): Promise<TRes> {
  const res = await fetch(`${siteUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg: string;
    try {
      msg =
        (JSON.parse(text) as { error?: string }).error ?? `HTTP ${res.status}`;
    } catch {
      // Non-JSON response — likely the SPA's 404 HTML. Don't leak the body
      // into a toast. The proxy is probably misconfigured or not running.
      msg = `${path} returned a non-JSON ${res.status}. The /_convex proxy may be down — restart pnpm dev:web.`;
    }
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as TRes;
}

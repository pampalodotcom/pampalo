// Browser-side base64url <-> ArrayBuffer helpers.

export function bufferToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBuffer(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function utf8ToBuffer(s: string): ArrayBuffer {
  // TextEncoder's underlying buffer is ArrayBuffer in browsers; copy to be safe.
  const u = new TextEncoder().encode(s);
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

export function bufferToUtf8(buf: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(buf);
}

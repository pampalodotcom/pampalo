import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

// Same-origin proxy for Convex HTTP actions. Runs as a pre-enforce
// middleware so it wins over tanstackStart()'s catch-all router; otherwise
// /_convex/* would render the SPA's 404 page.
function convexHttpProxy(target: string | undefined): Plugin {
  return {
    name: "pampalo-convex-http-proxy",
    enforce: "pre",
    configureServer(server) {
      if (!target) {
        console.warn(
          "[pampalo] VITE_CONVEX_SITE_URL is not set; /_convex proxy disabled",
        );
        return;
      }
      const upstream = target.replace(/\/$/, "");
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next) => {
          if (!req.url || !req.url.startsWith("/_convex")) return next();

          try {
            const subpath = req.url.replace(/^\/_convex/, "") || "/";
            const targetUrl = upstream + subpath;

            // Build forwarded headers, dropping hop-by-hop and host so the
            // upstream sees its own host and our cookies are preserved.
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (v === undefined) continue;
              const key = k.toLowerCase();
              if (
                key === "host" ||
                key === "connection" ||
                key === "content-length"
              ) {
                continue;
              }
              headers.set(key, Array.isArray(v) ? v.join(",") : String(v));
            }

            const method = (req.method ?? "GET").toUpperCase();
            const init: RequestInit = {
              method,
              headers,
              redirect: "manual",
            };
            if (method !== "GET" && method !== "HEAD") {
              const buf = await readRequestBody(req);
              init.body = new Uint8Array(buf);
              (init as { duplex?: string }).duplex = "half";
            }

            const upstreamRes = await fetch(targetUrl, init);
            res.statusCode = upstreamRes.status;
            upstreamRes.headers.forEach((value, key) => {
              const lower = key.toLowerCase();
              // Node fetch already decompressed the body; passing through
              // the upstream's content-encoding/length would cause the
              // browser to try to gunzip plaintext.
              if (
                lower === "content-encoding" ||
                lower === "content-length" ||
                lower === "transfer-encoding"
              ) {
                return;
              }
              if (lower === "set-cookie") {
                const existing = res.getHeader("set-cookie");
                const arr = Array.isArray(existing)
                  ? [...existing, value]
                  : existing
                    ? [String(existing), value]
                    : [value];
                res.setHeader("set-cookie", arr);
              } else {
                res.setHeader(key, value);
              }
            });
            if (upstreamRes.body) {
              const buf = Buffer.from(await upstreamRes.arrayBuffer());
              res.end(buf);
            } else {
              res.end();
            }
          } catch (err) {
            console.error("[pampalo] /_convex proxy error", err);
            next(err);
          }
        },
      );
    },
  };
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const config = defineConfig(({ mode }) => {
  // Vite reads .env files; Vercel exposes its UI-configured env vars on
  // process.env at build time. Merge so both work.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  const convexSite = env.VITE_CONVEX_SITE_URL?.replace(/\/$/, "");

  return {
    resolve: { tsconfigPaths: true },
    plugins: [
      // Local-dev proxy (vite dev only).
      convexHttpProxy(convexSite),
      devtools(),
      nitro({
        preset: "vercel",
        rollupConfig: { external: [/^@sentry\//] },
        // Production proxy: Nitro routeRules translate to Vercel rewrites
        // at build time. The destination is baked from VITE_CONVEX_SITE_URL,
        // which Vercel sets per-environment (Production / Preview / etc.).
        routeRules: convexSite
          ? { "/_convex/**": { proxy: `${convexSite}/**` } }
          : undefined,
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  };
});

export default config;

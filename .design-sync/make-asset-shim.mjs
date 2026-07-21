// Inlines the public/ brand assets that components reference by absolute
// URL (e.g. <img src="/pampalo-circular.svg">) as CSS content: replacements,
// so previews and claude.ai/design renders show the real assets outside the
// app. Appended to the compiled Tailwind CSS by cfg.buildCmd.
import { readFileSync, writeFileSync } from "node:fs";

const ASSETS = [
  "pampalo-circular.svg",
  "eth-logo.png",
  "usdc-logo.png",
  "audd-logo.png",
  "link-logo.png",
  "base-logo.svg",
];
const mime = (f) => (f.endsWith(".svg") ? "image/svg+xml" : "image/png");

let css =
  "\n/* app-hosted brand assets inlined so absolute /public URLs resolve outside the app (see .design-sync/make-asset-shim.mjs) */\n";
for (const f of ASSETS) {
  const b64 = readFileSync(`public/${f}`).toString("base64");
  css += `img[src="/${f}"] { content: url("data:${mime(f)};base64,${b64}"); }\n`;
}
writeFileSync(".design-sync/.cache/asset-shim.css", css);
console.log(`asset-shim.css: ${ASSETS.length} assets inlined`);

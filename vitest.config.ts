import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["src/**/*.test.{ts,tsx}", "convex/**/*.test.ts"],
    // Fixture addresses for unit tests. Override via shell env when
    // running against a different fixture (e.g. CI's own test wallet).
    env: {
      TEST_ADDRESS:
        process.env.TEST_ADDRESS ??
        "0x405338F496D665C821518107895F0b9639Fde789",
    },
  },
});

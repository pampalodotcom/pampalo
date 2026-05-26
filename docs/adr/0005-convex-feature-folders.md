# Convex code lives in feature folders, not at convex/ root

`convex/` is organised by **feature folder**, not as a flat collection of
files. Each folder groups the modules that share a domain concern:

```
convex/
├── crons.ts        ┐
├── http.ts         │ ← must stay at root (Convex requires these paths)
├── schema.ts       ┘
├── _generated/
│
├── auth/           ceremony.ts, node.ts          (passkey + session)
├── balances/       proxy.ts, types.ts            (dashboard RPC reads)
├── send/           proxy.ts, types.ts            (ADR 0004 send-flow proxies)
├── prices/         prices.ts, gas.ts, refresh.ts (chainlink + gas crons)
├── catalog/        networks.ts, tokens.ts,
│                   seed.ts, internal.ts          (public on-chain catalog)
├── preferences/    mutations.ts                  (encrypted blob CRUD)
├── swap/           actions.ts, abi.ts, types.ts  (uniswap quoting)
└── lib/            alchemy.ts, evm.ts            (pure server helpers,
                                                   no registered functions)
```

Conventions inside a folder:

- **One file per concern**, named for what it does (`proxy.ts`,
  `ceremony.ts`, `refresh.ts`), not by function-kind (`actions.ts`,
  `queries.ts`). The Convex `api` reference reads better:
  `api.send.proxy.getNonce` says "the RPC-proxy half of send".
- **`types.ts` per feature** holds types that the feature's actions
  return or accept. Server-only — the client keeps its own shape (see
  CONTEXT.md "client-side first"; ADR 0001 makes the persisted-data
  threat model asymmetric across the boundary, and the duplication
  pattern in `src/lib/uniswap-swap.ts:8-12` is explicitly preserved).
- **Tests live as siblings** (`proxy.ts` next to `proxy.test.ts`).
  Vitest picks them up via `convex/**/*.test.ts`; Convex's bundler
  ignores `*.test.ts` automatically (they don't appear in the
  generated `api.d.ts`). **Wart**: vite's `import.meta.glob`
  canonicalizes the keys to the shortest relative path, so a glob
  from `convex/balances/proxy.test.ts` returns sibling matches as
  `./proxy.ts` while non-siblings come back as `../auth/ceremony.ts`.
  convex-test's single-prefix module lookup then fails to resolve the
  test's own module. Workaround in each test file:
  ```ts
  const FOLDER = "balances";
  const raw = import.meta.glob("../**/*.ts");
  const modules = Object.fromEntries(
    Object.entries(raw).map(([k, v]) =>
      k.startsWith("./") ? [`../${FOLDER}/${k.slice(2)}`, v] : [k, v],
    ),
  );
  ```
  Five-line boilerplate per test. Future convex-test releases may
  make this unnecessary; the workaround is concentrated at the top of
  each test file so it's easy to remove if so.
- **`convex/lib/`** holds pure helpers that don't register Convex
  functions — the Alchemy fetch wrapper, address normalisation, hex
  padding. Anything that needs to be a Convex function lives in a
  feature folder, not lib.
- **Shared internal queries** (used by more than one feature) live
  with the feature that owns the data they read. Example:
  `internal.catalog.internal._networkForAction` reads from
  `supportedNetworks` and is consumed by `balances/`, `send/`, and
  `prices/refresh.ts`.

## Consequences

- Public API surface renames: `api.rpcProxy.getNativeBalance` becomes
  `api.balances.proxy.getNative`, etc. Client callsites in
  `src/lib/rpc.ts`, `SendModal.tsx`, `SwapModal.tsx`, `wallet.tsx`, and
  `convex/crons.ts` shift accordingly. Mechanical, but real diff.
- New features start with a folder, never a file at root. A future
  engineer adding (say) a withdrawal flow makes `convex/withdraw/`,
  not `convex/withdraw.ts`.
- The `index.ts` convention is *not* used. Convex's module names are
  paths-with-slashes (`"balances/proxy"`), and an `index.ts` would
  register as `"balances/index"` rather than `"balances"` — confusing
  at the callsite. One named file per concern reads cleaner.
- Generated `_generated/api.d.ts` enumerates modules as
  `"folder/file": typeof folder_file`. This is Convex's existing
  behaviour, already proven by `swap/abi` before this ADR.

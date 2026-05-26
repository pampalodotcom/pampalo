# Send flow uses thin RPC proxies, not bundled builders

The send-flow's server-side surface is restricted to **atomic,
single-purpose proxy actions** that leak no more than the existing
balance proxies (`getNativeBalance` / `getTokenBalance`, which see
`(chainId, address)`). The full allowed set:

- `getNativeBalance(chainId, address)` — existing.
- `getTokenBalance(chainId, address, tokenAddress, …)` — existing.
- `getNonce(chainId, address)` — added.
- `sendRawTransaction(chainId, rawTx)` — added. The signed tx is
  necessarily public the moment it broadcasts.
- `getTransactionStatus(chainId, txHash)` — added. The txHash is public
  on-chain.

**Bundled server-side builders that would see a pre-broadcast unsigned
transaction (i.e. `(from, to, value, data)` together) are not allowed.**
An earlier `getTransactionContext` action which combined nonce + EIP-1559
fee fetch + `eth_estimateGas` was prototyped and removed for this reason
— it created a censorship surface that doesn't exist for the atomic
calls (the server could read tx intent and refuse to relay), and bundled
in `eth_estimateGas`, which is the one piece of the proxy that genuinely
reveals user intent before broadcast.

Concrete consequences for the send flow:

- **Gas pricing** comes from the existing `latestGas` cron query
  (`api.gas.latestForChain`), not from a per-send fresh RPC fetch.
  Up-to-60s staleness (per `convex/crons.ts` 1-minute cadence) is
  absorbed by a slower / standard / faster / stupid-fast tier
  multiplier (mirroring the swap-review UX in `ReviewSwap.tsx`),
  letting the user pay for speed when they know the chain is moving.
- **`eth_estimateGas` is dropped** from the send flow entirely. The
  fallback `gasLimit` is `21_000` (native) or `65_000` (ERC20),
  each padded by 1.2×. This covers every real-world ETH or ERC20
  `transfer(address,uint256)` including first-time USDC sends to a
  fresh recipient. More complex flows (multi-hop swaps, arbitrary
  contract interactions) may reintroduce estimation, but as a
  purpose-specific call, not a generic builder.
- **All RPC-touching code in the send path goes through
  `useRpcClient()` / the `RpcClient` interface** (`src/lib/rpc.ts`),
  never directly via `useAction`. The interface grows from 2 methods
  to 5 (the list above). This keeps the BYO-RPC migration noted in
  `PRICE.md` mechanical: when BYO ships, the `DirectRpcClient`
  implementation substitutes in and the proxy becomes opt-in.

## Consequences

- A future engineer who wants to add a server-side helper for a new
  send variant must justify it against the allowed list. If the helper
  would see a pre-broadcast `(from, to, value, data)`, the answer is
  no — push it client-side or decompose into atomic calls.
- The privacy posture **is not** changed by this ADR. ADR 0001 governs
  what the server *persists*; the "client-side first" invariant in
  `CONTEXT.md` governs what the server *does* in transit; this ADR
  applies that invariant to the send flow. Together they bound the
  threat model.
- Mainnet sends during real gas spikes may occasionally underprice if
  the user stays on the "standard" tier — recoverable by submitting a
  replacement transaction (tracked as future work; not implemented in
  v1).

// Server-side return types for the balance proxy actions. Per ADR 0005,
// the client keeps its own shape (see `src/lib/rpc.ts`) — these two
// types do NOT cross the client/server boundary by import. The duplication
// is deliberate (see `src/lib/uniswap-swap.ts:8-12` for the same pattern).

export type NativeBalanceResult = {
  chainId: number;
  address: string;
  balanceWei: string;
  decimals: number;
  symbol: string;
  isNative: boolean;
  fetchedAt: number;
};

export type TokenBalanceResult = {
  chainId: number;
  address: string;
  tokenAddress: string;
  balanceWei: string;
  decimals: number;
  symbol: string;
  fetchedAt: number;
};

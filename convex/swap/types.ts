// Server-side return types for the uniswap quoting + pool-lookup actions.
// Per ADR 0005, the client keeps its own shape — these types do NOT
// cross the boundary.

export type PoolResult = {
  chainId: number;
  version: "v2" | "v3";
  token0: string;
  token1: string;
  fee?: number;
  address: string | null; // null if no pool exists
  liquidity: string | null; // v2: token0 reserve; v3: liquidity(). null if no pool.
  available: boolean; // address != 0x0 AND liquidity > 0
};

export type QuoteKind = "exactIn" | "exactOut";

export type QuoteResult = {
  chainId: number;
  version: "v2" | "v3";
  kind: QuoteKind;
  tokenIn: string; // resolved (WETH if ETH sentinel was passed)
  tokenOut: string;
  amountIn: string; // wei
  amountOut: string; // wei
  poolAddress: string;
  fee?: number; // v3
  sqrtPriceX96After?: string; // v3 only
  fetchedAt: number;
};

export type QuoteOption = {
  version: "v2" | "v3";
  fee?: number; // v3 only
  poolAddress: string | null;
  amountIn: string | null;
  amountOut: string | null;
  /** Gas units needed to execute this swap (decimal string). V3 reads
   *  the figure from QuoterV2's response; V2 uses a hardcoded typical
   *  (no on-chain quoter). null when the option isn't available. */
  gasEstimateUnits: string | null;
  available: boolean;
  error?: string;
};

export type AllQuotesResult = {
  chainId: number;
  kind: QuoteKind;
  tokenIn: string; // resolved (WETH if ETH sentinel was passed)
  tokenOut: string;
  amount: string; // the input the user specified
  options: QuoteOption[];
  fetchedAt: number;
};

// Server-side return types for the send-flow proxy actions. Per ADR 0005
// the client keeps its own shape (see `src/lib/rpc.ts`). ADR 0004
// governs why these three actions (and only these three) are the
// allowed server-side surface for sends.

export type NonceResult = {
  chainId: number;
  address: string;
  /** Decimal string; "pending" tag includes any in-flight tx the user
   *  has already broadcast, so two sends in quick succession get
   *  monotonically increasing nonces without a stuck-tx collision. */
  nonce: string;
  fetchedAt: number;
};

export type SendRawTransactionResult = {
  chainId: number;
  txHash: string;
};

export type TransactionStatusResult = {
  chainId: number;
  txHash: string;
  /** null when the transaction isn't mined yet. */
  blockNumber: number | null;
  /** null = pending. true = success. false = reverted. */
  status: boolean | null;
  /** Latest block on the chain. Used for confirmation count math. */
  currentBlock: number;
  /** Best-effort confirmations count (currentBlock - blockNumber + 1).
   *  0 while pending. */
  confirmations: number;
  fetchedAt: number;
};

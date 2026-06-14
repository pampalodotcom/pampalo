import type { RelayKind, RpcClient } from "./rpc";

// Shared relay-vs-self-broadcast decision for the private write flows
// (transfer, unshield). On a sponsoring chain we ask Pampalo's relayer to
// broadcast so the user's EVM address never signs the tx (ADR 0015). If
// the pool can't (busy/exhausted/not-sponsored) we fall back to the
// pre-signed self-broadcast tx — but only after the caller's
// `confirmFallback` returns true, because self-broadcasting publicly links
// the user's address (TRANSFERS.md §6.4). We never silently self-broadcast.
//
// The caller pre-signs the self-broadcast tx inside the SAME passkey unlock
// that generated the proof, so the fallback needs no second ceremony.

/** Thrown when the user declines the self-broadcast fallback. Callers
 *  treat this as a benign cancel (reset to idle, no error toast). */
export class BroadcastCancelledError extends Error {
  constructor() {
    super("self-broadcast declined");
    this.name = "BroadcastCancelledError";
  }
}

export type PrivateBroadcastOutcome = {
  txHash: string;
  /** "relay" = gas-sponsored (address-unlinked); "self" = own wallet. */
  via: "relay" | "self";
};

export async function broadcastPrivate(opts: {
  rpc: RpcClient;
  /** deployment.sponsoringTxs for this chain. */
  sponsoring: boolean;
  chainId: number;
  kind: RelayKind;
  proof: string;
  publicInputs: readonly string[];
  /** transfer + unshieldBundled both carry NotePayload ciphertexts. */
  payload?: readonly string[];
  /** swap only: the opaque Uniswap route bytes. */
  route?: string;
  /** Signed self-broadcast tx, pre-built in the unlock as the fallback. */
  signedSelfBroadcast: string;
  /** Resolves true if the user accepts self-broadcast, false to cancel. */
  confirmFallback: () => Promise<boolean>;
}): Promise<PrivateBroadcastOutcome> {
  const selfBroadcast = async (): Promise<PrivateBroadcastOutcome> => {
    const { txHash } = await opts.rpc.sendRawTransaction(
      opts.chainId,
      opts.signedSelfBroadcast,
    );
    return { txHash, via: "self" };
  };

  if (!opts.sponsoring) return selfBroadcast();

  const res = await opts.rpc.relay({
    chainId: opts.chainId,
    kind: opts.kind,
    proof: opts.proof,
    publicInputs: opts.publicInputs,
    payload: opts.payload,
    route: opts.route,
  });

  if (res.ok) return { txHash: res.txHash, via: "relay" };

  // A real on-chain revert would fire from any sender — surface it, don't
  // burn a self-broadcast on a tx that can't succeed.
  if (res.reason === "WOULD_REVERT") {
    throw new Error(res.revertReason || "Transaction would revert on-chain.");
  }

  // POOL_EXHAUSTED | CHAIN_NOT_SPONSORED | BAD_PROOF | UNKNOWN: the proof is
  // fine on-chain, the relayer just couldn't help. Offer self-broadcast.
  const accepted = await opts.confirmFallback();
  if (!accepted) throw new BroadcastCancelledError();
  return selfBroadcast();
}

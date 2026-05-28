// Shared note shapes between the prover (browser + Hardhat tests) and
// any code that builds witnesses or reasons about merkle inclusion.
//
// `ShieldNote` is the four-tuple that becomes a single merkle leaf
// when a user shields. `InputNote` is the spend-side shape consumed by
// the transfer / unshield / unshieldBundled circuits — same four
// fields plus the merkle path. `OutputNote` is the produced-side
// shape: a fresh note the spender is creating for some recipient.

export interface ShieldNote {
  assetId: string | bigint;
  assetAmount: string | bigint;
  secret: string | bigint;
  owner: string | bigint;
}

export interface InputNote {
  asset_id: string;
  asset_amount: string;
  owner: string;
  owner_secret: string;
  secret: string;
  leaf_index: string;
  path: string[];
  path_indices: string[];
}

export interface OutputNote {
  owner: string;
  secret: string;
  asset_id: string;
  asset_amount: string;
  external_address?: string;
}

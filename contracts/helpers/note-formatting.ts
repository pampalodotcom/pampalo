import { TREE_HEIGHT } from "./tree-config.js";

// Witness shapes consumed by the transfer / unshield / unshieldBundled
// circuits. `createInputNote` / `createOutputNote` are convenience
// builders so test code doesn't have to remember to stringify every
// bigint by hand.

export const createInputNote = (
  assetId: bigint | string,
  amount: bigint | string,
  owner: bigint | string,
  ownerSecret: bigint | string,
  secret: bigint | string,
  leafIndex: bigint | string,
  path: bigint[] | string[],
  pathIndices: bigint[] | number[],
) => {
  return {
    asset_id: assetId.toString(),
    asset_amount: amount.toString(),
    owner: owner.toString(),
    owner_secret: ownerSecret.toString(),
    secret: secret.toString(),
    leaf_index: leafIndex.toString(),
    path: path.map((item) => BigInt(item.toString()).toString()),
    path_indices: pathIndices.map((item) => item.toString()),
  };
};

const ZERO_SIBLING_LIST = new Array(TREE_HEIGHT - 1).fill(0n);
const ZERO_INDEX_LIST = new Array(TREE_HEIGHT - 1).fill(0n);

export const emptyInputNote = createInputNote(
  0n,
  0n,
  0n,
  0n,
  0n,
  0n,
  ZERO_SIBLING_LIST,
  ZERO_INDEX_LIST,
);

export const createOutputNote = (
  owner: bigint | string,
  secret: bigint | string,
  assetId: bigint | string,
  assetAmount: bigint | string,
  externalAddress?: bigint | string,
) => {
  return {
    owner: owner.toString(),
    secret: secret.toString(),
    asset_id: assetId.toString(),
    asset_amount: assetAmount.toString(),
    external_address: (externalAddress ?? 0n).toString(),
  };
};

export const emptyOutputNote = createOutputNote(0n, 0n, 0n, 0n, 0n);

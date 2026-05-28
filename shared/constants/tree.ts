// Pampalo merkle tree dimensions. Single source of truth — must match
// `pum_lib::HEIGHT` in circuits/pum_lib/src/lib.nr and
// `PoseidonMerkleTree.TREE_HEIGHT` in
// contracts/contracts/PoseidonMerkleTree.sol.

export const TREE_HEIGHT = 12;
export const MAX_LEAF_INDEX = 1 << (TREE_HEIGHT - 1); // 2048

// Circuit public-input layout (transfer_external + withdraw). Indices
// match the verifier's slot map exactly — see CONTRACTS_PLAN.md §5.
export const NOTES_INPUT_LENGTH = 3;
export const EXIT_ASSET_START_INDEX = 4;
export const EXIT_AMOUNT_START_INDEX = 7;
export const EXIT_ADDRESSES_START_INDEX = 10;

// Sentinel for native ETH in (asset, amount) tuples.
export const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

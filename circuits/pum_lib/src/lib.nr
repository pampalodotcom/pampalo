use poseidon;
use poseidon::poseidon2;

// Single source of truth for tree height across all circuits.
// Bumping this value automatically resizes the path/path_indices arrays
// in every circuit that imports HEIGHT from this module.
pub global HEIGHT: u32 = 12;

pub fn calculate_leaf(asset_id: Field, asset_amount: Field, owner: Field, secret: Field) -> Field {
    let leaf_hash =
        poseidon::poseidon2::Poseidon2::hash([asset_id, asset_amount, owner, secret], 4);

    leaf_hash
}

pub fn compute_merkle_root(
    leaf: Field,
    path: [Field; HEIGHT - 1],
    path_indices: [Field; HEIGHT - 1],
) -> Field {
    let mut current = leaf;
    for i in 0..HEIGHT - 1 {
        let path_bit = path_indices[i];
        let (hash_left, hash_right) = if path_bit == 0 {
            (path[i], current)
        } else {
            (current, path[i])
        };
        current = poseidon2::Poseidon2::hash([hash_left, hash_right], 2);
    }
    current
}

pub fn compute_nullifier(
    leaf_index: Field,
    owner: Field,
    secret: Field,
    asset_id: Field,
    asset_amount: Field,
) -> Field {
    poseidon2::Poseidon2::hash([leaf_index, owner, secret, asset_id, asset_amount], 5)
}

pub fn reconstruct_leaf(
    asset_id: Field,
    asset_amount: Field,
    owner: Field,
    secret: Field,
) -> Field {
    poseidon2::Poseidon2::hash([asset_id, asset_amount, owner, secret], 4)
}

// Domain tag for the redeem (proof-of-payment) nullifier, kept distinct
// from the spend nullifier (`compute_nullifier`). A note paid to a
// merchant is later spent by that merchant via a normal transfer/unshield,
// which burns the SPEND nullifier. The redeem path proves the same note
// merely *exists* and burns the REDEEM nullifier. Sharing one value would
// let either action grief the other (whoever acts first locks out the
// second), so the two live in separate domains.
//
// Value = keccak256("PAMPALO_REDEEM_V1") reduced mod the BN254 scalar
// field. Mirrored in shared/constants/zk.ts (REDEEM_DOMAIN) -- the two
// MUST stay in lockstep.
pub global REDEEM_DOMAIN: Field =
    0x1fbbd0b6d86010b7561c935f8b2fa24f7c0bcbd567023d2507130815387f017f;

pub fn compute_redeem_nullifier(
    leaf_index: Field,
    owner: Field,
    secret: Field,
    asset_id: Field,
    asset_amount: Field,
) -> Field {
    poseidon2::Poseidon2::hash(
        [REDEEM_DOMAIN, leaf_index, owner, secret, asset_id, asset_amount],
        6,
    )
}

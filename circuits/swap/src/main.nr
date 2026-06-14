use poseidon::poseidon2;
use pum_lib::{compute_merkle_root, compute_nullifier, HEIGHT, reconstruct_leaf};

// Private-swap circuit (ADR 0020). A swap spends up to NOTE_COUNT input
// notes -- all of `input_asset` -- and mints two output notes:
//
//   * a FIXED-OUTPUT note of `output_asset` at the target amount `T`,
//     committed in-circuit (output_hashes[0], public index 4); and
//   * an optional same-asset CHANGE note for whatever asset-A is left
//     after `input_amount` is sent into the pool (output_hashes[1],
//     public index 5).
//
// The realized AMM output does NOT exist at proof time, so it is never
// seen here -- the contract enforces `realized >= T` on-chain and
// forfeits the surplus. This is the irreducible shape of swapping
// against public liquidity (see ADR 0020).
//
// The circuit is a clone of `transfer`'s input side (ownership +
// membership + nullifier per spent note) with the cross-asset balance
// check replaced by a single same-asset conservation:
//
//     sum(input note amounts) == input_amount + change_amount
//
// where `input_amount` is the asset-A sent into the pool and
// `change_amount` is the asset-A returned to the user as a note.
//
// Public-input layout (MUST match PampaloSwapBase's index constants):
//
//   | idx | field            |
//   |-----|------------------|
//   | 0   | root             |
//   | 1-3 | nullifiers[3]    |
//   | 4-6 | output_hashes[3] | [4]=B@T, [5]=A change, [6]=0
//   | 7   | input_asset      |
//   | 8   | input_amount     |
//   | 9   | output_asset     |
//   | 10  | target_output T  |

global NOTE_COUNT: u32 = 3;

struct InputNote {
    asset_id: Field,
    asset_amount: Field,
    owner: Field,
    owner_secret: Field,
    secret: Field,
    leaf_index: Field,
    path: [Field; HEIGHT - 1],
    path_indices: [Field; HEIGHT - 1],
}

fn main(
    root: pub Field,
    input_notes: [InputNote; NOTE_COUNT],
    nullifiers: pub [Field; NOTE_COUNT],
    output_hashes: pub [Field; NOTE_COUNT],
    input_asset: pub Field,
    input_amount: pub Field,
    output_asset: pub Field,
    target_output: pub Field,
    // Private witnesses for the two minted notes. These never consume a
    // public-input index; only their commitments (output_hashes) do.
    swap_output_owner: Field,
    swap_output_secret: Field,
    change_amount: Field,
    change_owner: Field,
    change_secret: Field,
) {
    // Pass 0: bound every amount to 128 bits. Mirrors `transfer`'s
    // defence against the BN254 field-overflow mint vector: an
    // unbounded `change_amount` of (p - input_amount) would wrap the
    // conservation sum to zero and mint a note from nothing.
    for i in 0..NOTE_COUNT {
        input_notes[i].asset_amount.assert_max_bit_size::<128>();
    }
    input_amount.assert_max_bit_size::<128>();
    target_output.assert_max_bit_size::<128>();
    change_amount.assert_max_bit_size::<128>();

    // A swap must send a non-zero amount into the pool and mint a
    // non-zero output note. (A zero `T` would be a degenerate empty
    // note; a zero `input_amount` would be a no-op spend.)
    assert(input_amount != 0, "input_amount must be non-zero");
    assert(target_output != 0, "target_output must be non-zero");

    // Pass 1: per-input verification + same-asset conservation.
    // Every non-empty input is `input_asset`, owned by the prover, a
    // member at `root`, with a consistent nullifier. Empty slots
    // (asset_amount == 0) drop out and contribute 0 to the sum.
    let mut in_sum: Field = 0;
    for i in 0..NOTE_COUNT {
        if input_notes[i].asset_amount != 0 {
            // Single-asset binding: the route's input currency is bound
            // to `input_asset` on-chain, so binding every spent note to
            // it here is what makes the swap spend the asset it claims.
            assert(input_notes[i].asset_id == input_asset, "input asset mismatch");

            let owner_pub_key = poseidon2::Poseidon2::hash([input_notes[i].owner_secret], 1);
            assert(owner_pub_key == input_notes[i].owner);

            let reconstructed_nullifier = compute_nullifier(
                input_notes[i].leaf_index,
                input_notes[i].owner,
                input_notes[i].secret,
                input_notes[i].asset_id,
                input_notes[i].asset_amount,
            );
            assert(reconstructed_nullifier == nullifiers[i]);

            let reconstructed_leaf = reconstruct_leaf(
                input_notes[i].asset_id,
                input_notes[i].asset_amount,
                input_notes[i].owner,
                input_notes[i].secret,
            );
            let reconstructed_root = compute_merkle_root(
                reconstructed_leaf,
                input_notes[i].path,
                input_notes[i].path_indices,
            );
            assert(reconstructed_root == root);

            in_sum += input_notes[i].asset_amount;
        }
    }

    // Conservation: everything spent is either sent into the pool or
    // returned as the asset-A change note. No asset-A is minted.
    assert(in_sum == input_amount + change_amount, "input conservation");

    // The swap output note: `output_asset` @ T. Committed in-circuit so
    // the contract never constructs a note on-chain (ADR 0020).
    let swap_leaf =
        reconstruct_leaf(output_asset, target_output, swap_output_owner, swap_output_secret);
    assert(swap_leaf == output_hashes[0], "swap output commitment mismatch");

    // The change note: asset-A @ change_amount, or 0 when there is no
    // change. A zero slot must carry a zero commitment so the contract
    // skips the insert.
    if change_amount != 0 {
        let change_leaf =
            reconstruct_leaf(input_asset, change_amount, change_owner, change_secret);
        assert(change_leaf == output_hashes[1], "change commitment mismatch");
    } else {
        assert(output_hashes[1] == 0, "non-zero change slot with zero change");
    }

    // The third output slot is unused by the swap shape.
    assert(output_hashes[2] == 0, "third output slot must be empty");
}

// ----- Tests ---------------------------------------------------------
// The input-note witness (root / leaf / path / nullifier) is reused
// verbatim from the `transfer` circuit's test fixture, so membership is
// provably valid against a real 1-leaf tree. Output commitments are
// computed inline via `reconstruct_leaf` -- no external hasher needed.

global TEST_ROOT: Field =
    4221110344891604176205088962198904729260430126413313722462390172704999703195;
global TEST_ASSET_A: Field = 1096978651789611665652906124278561787240579697095;
global TEST_OWNER: Field =
    10812186542955647827474372651967207045861174805371180171801345448553285386806;
global TEST_OWNER_SECRET: Field =
    10036677144260647934022413515521823129584317400947571241312859176539726523915;
global TEST_SECRET: Field =
    2389312107716289199307843900794656424062350252250388738019021107824217896920;
global TEST_NULLIFIER: Field =
    3889730504789135603011318287331683111639714777739573239289638917879152395137;
// An arbitrary distinct asset id standing in for the output asset (B).
global TEST_ASSET_B: Field = 999888777666555444333222111;

fn test_input_note() -> InputNote {
    let path = [
        13640659629327953230197633652529006805891215582818597888084863207147219313784,
        19984673905358619496530873554532699316557532969285237470013525856790495658245,
        16054022188397161938956278061878851932956033792728066452148841350372709856325,
        5088416905632566847489144423785449560596474956704206833561295200206123281740,
        7133742548945823648162717112853949322814446130740022056636610844051076979955,
        15996976533936258369996214630141201173712053425083354410411158951568838211277,
        12856765864455281126306545538308148448222111081433610923407492298111988109924,
        4407863489559565071205165471845081321675763465852502126771740970311657294198,
        20448284296610764092326252358036828964180135505542140040145855516028834425624,
        7022843789375185322738689530892530453984779704784378294646894048972162829679,
        10906054357754859492130109809751867122631984061959461434096281674698176679467,
    ];
    let path_indices = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

    InputNote {
        asset_id: TEST_ASSET_A,
        asset_amount: 5,
        owner: TEST_OWNER,
        owner_secret: TEST_OWNER_SECRET,
        secret: TEST_SECRET,
        leaf_index: 0,
        path,
        path_indices,
    }
}

fn empty_input_note() -> InputNote {
    InputNote {
        asset_id: 0,
        asset_amount: 0,
        owner: 0,
        owner_secret: 0,
        secret: 0,
        leaf_index: 0,
        path: [0; HEIGHT - 1],
        path_indices: [0; HEIGHT - 1],
    }
}

// Spend a 5-unit asset-A note entirely into the pool, mint one asset-B
// note at T = 4, no change.
#[test]
fn test_swap_no_change() {
    let b_owner = TEST_OWNER;
    let b_secret = TEST_SECRET;
    let target_output: Field = 4;

    let swap_leaf = reconstruct_leaf(TEST_ASSET_B, target_output, b_owner, b_secret);

    main(
        TEST_ROOT,
        [test_input_note(), empty_input_note(), empty_input_note()],
        [TEST_NULLIFIER, 0, 0],
        [swap_leaf, 0, 0],
        TEST_ASSET_A,
        /*input_amount*/ 5,
        TEST_ASSET_B,
        target_output,
        b_owner,
        b_secret,
        /*change_amount*/ 0,
        /*change_owner*/ 0,
        /*change_secret*/ 0,
    );
}

// Spend the 5-unit note but only send 3 into the pool; mint an asset-B
// note at T = 2 and a 2-unit asset-A change note back to the owner.
#[test]
fn test_swap_with_change() {
    let b_owner = TEST_OWNER;
    let b_secret = TEST_SECRET;
    let target_output: Field = 2;
    let change_amount: Field = 2;
    let change_owner = TEST_OWNER;
    let change_secret = TEST_OWNER_SECRET;

    let swap_leaf = reconstruct_leaf(TEST_ASSET_B, target_output, b_owner, b_secret);
    let change_leaf = reconstruct_leaf(TEST_ASSET_A, change_amount, change_owner, change_secret);

    main(
        TEST_ROOT,
        [test_input_note(), empty_input_note(), empty_input_note()],
        [TEST_NULLIFIER, 0, 0],
        [swap_leaf, change_leaf, 0],
        TEST_ASSET_A,
        /*input_amount*/ 3,
        TEST_ASSET_B,
        target_output,
        b_owner,
        b_secret,
        change_amount,
        change_owner,
        change_secret,
    );
}

// Overspend: claim to send 6 into the pool (plus 0 change) while only
// spending a 5-unit note. Conservation must reject this.
#[test(should_fail_with = "input conservation")]
fn test_swap_overspend_rejected() {
    let b_owner = TEST_OWNER;
    let b_secret = TEST_SECRET;
    let target_output: Field = 6;

    let swap_leaf = reconstruct_leaf(TEST_ASSET_B, target_output, b_owner, b_secret);

    main(
        TEST_ROOT,
        [test_input_note(), empty_input_note(), empty_input_note()],
        [TEST_NULLIFIER, 0, 0],
        [swap_leaf, 0, 0],
        TEST_ASSET_A,
        /*input_amount*/ 6,
        TEST_ASSET_B,
        target_output,
        b_owner,
        b_secret,
        /*change_amount*/ 0,
        /*change_owner*/ 0,
        /*change_secret*/ 0,
    );
}

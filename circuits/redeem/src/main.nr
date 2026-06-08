use pum_lib::{compute_merkle_root, compute_redeem_nullifier, HEIGHT, reconstruct_leaf};

// Proof-of-payment (redeem) circuit. A trimmed, single-input cousin of
// `withdraw`: no balance check, no outputs, no spend. It proves only
// that a note *exists* in a known Pampalo merkle root, owned by a given
// merchant identifier, worth a given (asset, amount).
//
// The buyer CREATES the merchant's payment note (a normal Pampalo
// transfer), so the buyer knows `secret`, the public `merchant_id`
// (= note owner), `asset_id`, `asset_amount`, and -- once the paying tx
// is indexed -- the `leaf_index` + merkle path. That is exactly enough
// to prove membership. The buyer does NOT know the merchant's
// owner_secret, so this is a proof of existence, never a spend.
//
// Frontrun / item-swap / griefing resistance: `recipient`, `consumer`
// and `reference` are pub inputs. Regenerating the proof with a
// different value for any of them requires the private witness
// (`secret`), which a mempool watcher does not have -- so the bound
// public-input vector pins all three.
//   - `recipient`: who the consuming contract delivers to.
//   - `consumer`:  the contract allowed to settle this proof. The
//     settlement singleton requires `msg.sender == consumer`, so a
//     watcher cannot copy the proof and burn the nullifier directly
//     (a burn-without-delivery DoS); the only path to the burn is the
//     consumer's own atomic verify-then-deliver call.
//   - `reference`: an opaque field the consuming contract interprets
//     (item id, cart hash, order id, ...).
// The redeem nullifier deliberately EXCLUDES recipient, consumer and
// reference, so one payment note can be redeemed at most ONCE, ever,
// regardless of which item / consumer it is pointed at.

fn main(
    root: pub Field,
    redeem_nullifier: pub Field,
    merchant_id: pub Field,
    asset_id: pub Field,
    asset_amount: pub Field,
    recipient: pub Field,
    consumer: pub Field,
    reference: pub Field,
    // private witness
    secret: Field,
    leaf_index: Field,
    path: [Field; HEIGHT - 1],
    path_indices: [Field; HEIGHT - 1],
) {
    // Bound the amount to 128 bits, matching transfer/withdraw. Keeps
    // any future witness builder from constructing a field-overflow
    // note even though there is no balance sum here to attack.
    asset_amount.assert_max_bit_size::<128>();

    // recipient + consumer are EVM addresses -- range-bound them so the
    // public-input vector can't smuggle a >160-bit value past the
    // contracts, which truncate to uint160.
    recipient.assert_max_bit_size::<160>();
    consumer.assert_max_bit_size::<160>();

    // Membership: reconstruct the merchant's payment leaf and prove it
    // sits under `root`.
    let leaf = reconstruct_leaf(asset_id, asset_amount, merchant_id, secret);
    let computed_root = compute_merkle_root(leaf, path, path_indices);
    assert(computed_root == root);

    // Domain-separated redeem nullifier (distinct from the spend
    // nullifier the merchant uses to later spend this note).
    let nf = compute_redeem_nullifier(leaf_index, merchant_id, secret, asset_id, asset_amount);
    assert(nf == redeem_nullifier);

    // `reference` carries no in-circuit semantics; it binds purely by
    // being part of the public-input vector. Touch it so it is an
    // explicit constraint-system input rather than relying on the ABI
    // alone.
    let _bound_reference = reference + 0;
}

#[test]
fn test_main() {
    // Reuses the membership fixture from circuits/withdraw/src/main.nr:
    // a real (root, leaf_index, path) triple for a note worth 2 of
    // `asset_id`, owned by `merchant_id`.
    let root = 9770762522284292133040204594656801249089743659015207279808423545223243067226;
    let asset_id = 1096978651789611665652906124278561787240579697095;
    let asset_amount = 2;
    let merchant_id =
        6868973719921785236727144517868768664734231208097695530688003960085654392226;
    let secret = 3957740128091467064337395812164919758932045173069261808814882570720300029469;
    let leaf_index = 2;

    let path = [
        13640659629327953230197633652529006805891215582818597888084863207147219313784,
        18380261439356865501884569257940638985761619337694138929913102368174989083576,
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
    let path_indices = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];

    let recipient = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    let consumer = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    let reference = 42;

    let redeem_nullifier =
        compute_redeem_nullifier(leaf_index, merchant_id, secret, asset_id, asset_amount);

    main(
        root,
        redeem_nullifier,
        merchant_id,
        asset_id,
        asset_amount,
        recipient,
        consumer,
        reference,
        secret,
        leaf_index,
        path,
        path_indices,
    );
}

#[test(should_fail)]
fn test_wrong_root_fails() {
    let root = 1234; // not the membership root
    let asset_id = 1096978651789611665652906124278561787240579697095;
    let asset_amount = 2;
    let merchant_id =
        6868973719921785236727144517868768664734231208097695530688003960085654392226;
    let secret = 3957740128091467064337395812164919758932045173069261808814882570720300029469;
    let leaf_index = 2;

    let path = [
        13640659629327953230197633652529006805891215582818597888084863207147219313784,
        18380261439356865501884569257940638985761619337694138929913102368174989083576,
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
    let path_indices = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];

    let recipient = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    let consumer = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    let reference = 42;

    let redeem_nullifier =
        compute_redeem_nullifier(leaf_index, merchant_id, secret, asset_id, asset_amount);

    main(
        root,
        redeem_nullifier,
        merchant_id,
        asset_id,
        asset_amount,
        recipient,
        consumer,
        reference,
        secret,
        leaf_index,
        path,
        path_indices,
    );
}

#[test(should_fail)]
fn test_tampered_nullifier_fails() {
    let root = 9770762522284292133040204594656801249089743659015207279808423545223243067226;
    let asset_id = 1096978651789611665652906124278561787240579697095;
    let asset_amount = 2;
    let merchant_id =
        6868973719921785236727144517868768664734231208097695530688003960085654392226;
    let secret = 3957740128091467064337395812164919758932045173069261808814882570720300029469;
    let leaf_index = 2;

    let path = [
        13640659629327953230197633652529006805891215582818597888084863207147219313784,
        18380261439356865501884569257940638985761619337694138929913102368174989083576,
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
    let path_indices = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];

    let recipient = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    let consumer = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    let reference = 42;

    // A redeem_nullifier that does not match the note -> must fail.
    let redeem_nullifier = 9999;

    main(
        root,
        redeem_nullifier,
        merchant_id,
        asset_id,
        asset_amount,
        recipient,
        consumer,
        reference,
        secret,
        leaf_index,
        path,
        path_indices,
    );
}

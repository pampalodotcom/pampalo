# Proof of Private Payment → ERC-721 Redemption

Status: **proposal / implementation plan** (not yet built)
Scope: a buyer pays a merchant privately through Pampalo, then redeems an
ERC-721 by proving that payment landed in a known merkle root, owned by a
merchant identity registered on the redeemer contract.

This document is the canonical plan for that feature. It is grounded in the
existing protocol (`CONTEXT.md`, `circuits/`, `contracts/contracts/Pampalo.sol`,
`convex/schema.ts`) and reuses its primitives wherever possible.

---

## 1. Goal & user story

> I list an ERC-721 for **$99 USDC**. A buyer may pay either with a plain
> ERC-20 transfer, **or** by proving a Pampalo private payment to a merchant
> identity registered on the contract. On valid proof, the contract releases
> the ERC-721 to an address the buyer chooses.

The ERC-20 path already exists in ordinary marketplace code and is out of
scope here. This plan covers **only** the proof-of-private-payment path.

### Two-step (non-atomic) flow

1. **Pay.** Buyer issues a Pampalo `transfer(...)` that creates one output
   note owned by the merchant's **Poseidon identifier**, with
   `asset_id = USDC`, `asset_amount = price`. The note's leaf is inserted into
   the tree immediately (transfers, unlike shields, have no 1-hour wait —
   `Pampalo.transfer` calls `_insert` in the same tx). The note secret is
   ECIES-encrypted to the merchant's **envelope key** and emitted as
   `NotePayload`, so the merchant can later spend the $99 normally.
2. **Redeem.** Buyer calls `PampaloRedeemer.redeem(proof, publicInputs,
   listingId, recipient)` proving "a note owned by `merchantId`, worth `price`
   of `USDC`, exists in a known root." The contract verifies the proof, burns
   a **redeem-domain nullifier** (distinct from the spend nullifier), checks
   the public inputs against the listing, and transfers the ERC-721 to
   `recipient`.

The merchant genuinely receives a spendable $99 USDC note; the redeem is a
separate "coupon" that gates the NFT. **These are independent** — see §4.1.

---

## 2. Why two steps (and why not 10M gas)

A single membership-style proof verifies in ~constant gas under UltraHonk
(the existing verifiers are `NUMBER_OF_PUBLIC_INPUTS`-sized Honk verifiers,
e.g. `WithdrawVerifier.sol`), so the redeem itself is **~300–500k gas**, not
millions. The reason to start non-atomic is **structural, not gas**:

- To prove membership you need the payment note already inserted, with a
  `leaf_index` and merkle path. Those only exist *after* the paying tx
  confirms. You cannot insert-and-prove-membership in one tx.

The real cost of non-atomicity is **settlement risk**, not gas — see §7.
An atomic variant is feasible and is sketched in Appendix A; we deliberately
defer it.

---

## 3. Cryptographic design

### 3.1 What the buyer can and cannot prove

A note's leaf is `poseidon2([asset_id, asset_amount, owner, secret])`
(`pum_lib::calculate_leaf`). The buyer **creates** the merchant's payment
note, so the buyer knows `secret`, `owner` (= merchant id, public), `asset_id`,
`asset_amount`, and after insertion the `leaf_index` + path. That is exactly
enough to prove **membership**.

The buyer does **not** know the merchant's `owner_secret`
(`owner = poseidon2([owner_secret])`), so the buyer can never *spend* the note
in the Pampalo sense. Good: the redeem is a proof of existence, not a spend.

### 3.2 The `redeem` circuit (new — `circuits/redeem/`)

A trimmed, single-input cousin of `withdraw`. No balance check, no outputs.

**Public inputs** (fixed order — the contract parses by index, mirroring
`Pampalo`'s `EXIT_*_START_INDEX` style):

| idx | name             | meaning                                                        |
|-----|------------------|----------------------------------------------------------------|
| 0   | `root`           | a Pampalo merkle root (checked via `isKnownRoot`)              |
| 1   | `redeem_nullifier` | domain-separated; burned to prevent double-redeem            |
| 2   | `merchant_id`    | the note `owner` = merchant Poseidon identifier                |
| 3   | `asset_id`       | payment asset (USDC address as a field)                        |
| 4   | `asset_amount`   | payment amount (base units)                                    |
| 5   | `listing_id`     | binds the proof to one listing                                 |
| 6   | `recipient`      | NFT recipient EVM address (uint160 in a field)                 |
| 7   | `recipient_hash` | `poseidon2([recipient])` — frontrun binding, like `withdraw`   |

**Private inputs:** `secret`, `leaf_index`, `path[HEIGHT-1]`,
`path_indices[HEIGHT-1]`.

**Constraints:**

```
// bound amount to 128 bits, matching transfer/withdraw
asset_amount.assert_max_bit_size::<128>();

let leaf = reconstruct_leaf(asset_id, asset_amount, merchant_id, secret);
assert(compute_merkle_root(leaf, path, path_indices) == root);

assert(compute_redeem_nullifier(leaf_index, merchant_id, secret,
                                asset_id, asset_amount) == redeem_nullifier);

assert(poseidon2([recipient], 1) == recipient_hash);
// listing_id is bound simply by being a `pub` input: any change flips the
// public-input vector and the Honk proof fails to verify. (Optionally fold
// it into recipient_hash as poseidon2([recipient, listing_id]) for an
// explicit in-circuit touch.)
```

**Binding logic (why this is frontrun-safe):** every field above is a `pub`
input, so the verifier binds the proof to the *exact* vector. A mempool
observer who copies the proof but swaps `recipient` or `listing_id` produces a
different public-input vector → `verify` returns false. This is the same
guarantee `withdraw` relies on for `exit_addresses` / `exit_address_hashes`
(`circuits/withdraw/src/main.nr:65`).

### 3.3 Domain-separated redeem nullifier (critical — add to `pum_lib`)

The merchant will later spend the $99 note via a normal `transfer`/`unshield`,
producing the **spend** nullifier
`poseidon2([leaf_index, owner, secret, asset_id, asset_amount])`
(`pum_lib::compute_nullifier`). If redeem reused that value, the two actions
would grief each other (whoever acts first locks out the other).

Add a distinct domain:

```rust
// circuits/pum_lib/src/lib.nr
pub global REDEEM_DOMAIN: Field = /* poseidon2-safe constant tag, e.g.
    keccak256("PAMPALO_REDEEM_V1") reduced mod p, baked as a literal */;

pub fn compute_redeem_nullifier(
    leaf_index: Field, owner: Field, secret: Field,
    asset_id: Field, asset_amount: Field,
) -> Field {
    poseidon2::Poseidon2::hash(
        [REDEEM_DOMAIN, leaf_index, owner, secret, asset_id, asset_amount], 6)
}
```

`REDEEM_DOMAIN` must be mirrored in `shared/constants/zk.ts`. The redeem
nullifier deliberately **excludes** `listing_id`, so a single payment note can
redeem **at most one** item ever (one $99 note → one $99 NFT). `listing_id` is
bound separately so the buyer chooses *which* item.

---

## 4. On-chain design

### 4.1 New contract: `PampaloRedeemer.sol`

Standalone (does **not** modify `Pampalo`). It reads roots from the live
Pampalo deployment and verifies via a new `RedeemVerifier`.

```solidity
contract PampaloRedeemer is AccessControlEnumerable, IERC721Receiver {
    Pampalo public immutable pampalo;        // for isKnownRoot
    IVerifier public immutable redeemVerifier;

    // merchant EVM address -> declared Poseidon identifier (+ envelope key
    // for discoverability; see §4.2). Self-declared, permissionless.
    mapping(address => uint256) public merchantId;

    struct Listing {
        address collection;   // ERC-721
        uint256 tokenId;      // the escrowed token (1-of-1) — see §6 for editions
        address asset;        // USDC
        uint256 price;        // base units, must equal proven asset_amount
        uint256 merchantId;   // payments must be owned by this Poseidon id
        address seller;       // who escrowed / can cancel
        bool open;
    }
    mapping(uint256 => Listing) public listings;   // listingId => Listing
    uint256 public nextListingId;

    mapping(bytes32 => bool) public redeemNullifierUsed;  // OWN namespace

    event MerchantRegistered(address indexed seller, uint256 merchantId);
    event ListingCreated(uint256 indexed listingId, address indexed collection,
                         uint256 tokenId, address asset, uint256 price,
                         uint256 merchantId, address indexed seller);
    event ListingCancelled(uint256 indexed listingId);
    event Redeemed(uint256 indexed listingId, bytes32 indexed redeemNullifier,
                  address indexed recipient);
}
```

Public-input index constants (match the §3.2 table):

```solidity
uint256 constant PI_ROOT = 0;
uint256 constant PI_NULLIFIER = 1;
uint256 constant PI_MERCHANT = 2;
uint256 constant PI_ASSET = 3;
uint256 constant PI_AMOUNT = 4;
uint256 constant PI_LISTING = 5;
uint256 constant PI_RECIPIENT = 6;
uint256 constant PI_RECIPIENT_HASH = 7;
```

### 4.2 Functions

**`registerMerchant(uint256 poseidonId)`** — `merchantId[msg.sender] = poseidonId`.
Permissionless self-declaration; declaring an id you don't control only harms
yourself (payments become unspendable by you). *Optional hardening:* require a
small proof of knowledge that `poseidonId == poseidon2([owner_secret])` to stop
squatting. Recommended companion: also publish the merchant **envelope key** so
buyers can ECIES-encrypt the note secret — or skip storage entirely and require
merchants to be a `name.pampalo.eth` (which already publishes both the Poseidon
identifier and envelope key; see `CONTEXT.md` "Pampalo username").

**`createListing(collection, tokenId, asset, price) → listingId`** — caller must
have a registered `merchantId`; the contract pulls the ERC-721 into escrow
(`safeTransferFrom(seller, this, tokenId)`), stores the listing `open`.

**`cancelListing(listingId)`** — seller-only; returns the escrowed token, sets
`open = false`.

**`redeem(bytes proof, bytes32[] publicInputs, uint256 listingId, address recipient)`:**

```solidity
function redeem(bytes calldata proof, bytes32[] calldata publicInputs,
                uint256 listingId, address recipient) external {
    require(isKnownRoot via pampalo.isKnownRoot(uint256(publicInputs[PI_ROOT])), "Invalid Root!");
    require(redeemVerifier.verify(proof, publicInputs), "Invalid redeem proof");

    bytes32 nf = publicInputs[PI_NULLIFIER];
    require(!redeemNullifierUsed[nf], "Already redeemed");
    redeemNullifierUsed[nf] = true;

    Listing storage L = listings[listingId];
    require(L.open, "Listing closed");
    require(uint256(publicInputs[PI_LISTING]) == listingId, "listing mismatch");
    require(uint256(publicInputs[PI_MERCHANT]) == L.merchantId, "merchant mismatch");
    require(address(uint160(uint256(publicInputs[PI_ASSET]))) == L.asset, "asset mismatch");
    require(uint256(publicInputs[PI_AMOUNT]) == L.price, "amount mismatch"); // exact for v1
    require(address(uint160(uint256(publicInputs[PI_RECIPIENT]))) == recipient, "recipient mismatch");

    L.open = false;
    IERC721(L.collection).safeTransferFrom(address(this), recipient, L.tokenId);
    emit Redeemed(listingId, nf, recipient);
}
```

Notes:
- `pampalo.isKnownRoot(...)` is already `public view`
  (`PoseidonMerkleTree.sol:161`) — no Pampalo change needed.
- The contract reuses the existing `IVerifier` interface
  (`verifiers/DepositVerifier.sol`); `RedeemVerifier` is just another Honk
  verifier deployed alongside it.
- `recipient` is passed explicitly **and** checked against the bound
  `PI_RECIPIENT` slot, so the caller can't redirect the token.

### 4.3 Reentrancy / ordering

State (`redeemNullifierUsed`, `L.open`) is written **before** the external
`safeTransferFrom` (checks-effects-interactions). `IERC721Receiver.onERC721Received`
is implemented for escrow-in.

---

## 5. Off-chain & client work

### 5.1 New circuit + verifier artifacts
- `circuits/redeem/{Nargo.toml, src/main.nr}` (+ `#[test] fn test_main` and a
  `#[test(should_fail)]` double-redeem / wrong-recipient regression, mirroring
  `circuits/transfer/src/main.nr`).
- `circuits/pum_lib/src/lib.nr`: add `REDEEM_DOMAIN` + `compute_redeem_nullifier`.
- Compile to `shared/circuits/redeem.json` (same pipeline that produced
  `deposit.json` / `transfer.json` / `withdraw.json`).
- Generate `contracts/contracts/verifiers/RedeemVerifier.sol` from the circuit
  (same `bb` → Solidity toolchain; note the `ZKTranscriptLib` library that the
  other verifiers link, see `ignition/modules/WithdrawVerifier.ts`).

### 5.2 Shared prover: `shared/classes/Redeem.ts`
Mirror `Unshield.ts` / `Transfer.ts`:
1. Look up the merchant payment note the buyer created (from IDB; its leaf
   commitment is known at creation).
2. Resolve `leaf_index` via `pampaloLeaves` (`by_deployment_and_commitment`)
   and build the merkle path with `shared/classes/PoseidonMerkleTree.ts`.
3. Compute `redeem_nullifier`, `recipient_hash`.
4. Generate the Honk proof (`@aztec/bb.js` `UltraHonkBackend`, as in the
   existing classes) and return `{ proof, publicInputs }`.

### 5.3 Convex (public catalog/event mirrors — NOT user-scoped)

These mirror **public on-chain** marketplace data, the same category as
`shieldQueueEntries` / `pampaloLeaves`. They hold no user secrets and do **not**
fall under the encrypted-mnemonic privacy invariant (recipient is a public
EVM address on-chain regardless). Add to `convex/schema.ts`:

- `pampaloListings`: `(deploymentId, listingId, collection, tokenId, asset,
  price, merchantId, seller, state: open|sold|cancelled, createdTxHash, …)`.
  Indexes: `by_deployment_and_state`, `by_deployment_and_listingId`.
- `pampaloRedemptions`: `(deploymentId, listingId, redeemNullifier, recipient,
  redeemedTxHash, redeemedAt)` — mirror of `Redeemed`. Index by listing.
- (optional) `pampaloMerchants`: `(deploymentId, seller, merchantId,
  envelopeKey?)` mirror of `MerchantRegistered`, to power a buyer-side
  "pay this merchant" lookup without an RPC.

Extend the existing event indexer to consume `ListingCreated`,
`ListingCancelled`, `Redeemed`, `MerchantRegistered`.

### 5.4 Client UX (buyer)
1. **Prerequisite:** buyer needs private USDC notes. If they only hold public
   USDC, they must `shield` first (1-hour wait) before they can `transfer`.
2. Pay: build a `transfer` to `(merchant Poseidon id, envelope key)` for
   `price` USDC (existing transfer flow / relayer).
3. Wait for the paying tx + leaf insertion to be indexed.
4. Redeem: `Redeem.ts` builds the proof; submit
   `PampaloRedeemer.redeem(...)` from the chosen `recipient` (or via relayer if
   recipient anonymity matters).

### 5.5 Deployment (Hardhat Ignition)
- `ignition/modules/RedeemVerifier.ts` (link `ZKTranscriptLib`, per the
  Withdraw module pattern).
- `ignition/modules/PampaloRedeemer.ts` — constructor `(pampalo, redeemVerifier)`.
- Record the new addresses in `pampaloDeployments` (extend `verifiers` object
  with `redeem`, and add a `redeemer` address field) so the client can find them.

---

## 6. Editions vs 1-of-1

The contract above escrows a single `tokenId` (1-of-1). For **editions**
(multi-supply), generalize a listing to hold either an inventory counter +
mint authority, or a pre-approved pool of `tokenId`s, decrementing on each
`redeem`. Editions also blunt the settlement race (§7): the race only bites at
the inventory boundary, whereas for a 1-of-1 the boundary is the entire item.

**Recommendation:** ship editions / made-to-order first; treat 1-of-1 as a
later mode that needs the reservation work in §7.

---

## 7. Settlement risk (the real tradeoff)

Because pay and redeem are separate txs, two buyers can pay for the same 1-of-1
before either redeems; only one gets the NFT, the other has paid the merchant
and is left to an **off-protocol refund**. Mitigations, in increasing cost:

1. **Document + merchant refund** (v1): client checks `listing.open` before
   paying; accept a small race window; merchant refunds losers. Fine for
   editions, sharp for 1-of-1.
2. **Reservation**: a short on-chain hold per listing (out of scope v1).
3. **Atomic** `transferAndRedeem` (Appendix A): removes the race entirely.

This — not gas — is the reason to be deliberate about which items use this path.

---

## 8. Threat model checklist

- [x] **Double-redeem** → per-note `redeem_nullifier` in its own mapping.
- [x] **Grief vs merchant spend** → domain separation from the spend nullifier.
- [x] **Frontrun / redirect** → `recipient` + `listing_id` bound as `pub` inputs.
- [x] **Wrong asset / amount / merchant** → contract checks public inputs vs listing.
- [x] **Stale root** → allowed by design (`isKnownRoot` never expires); buyer may
      redeem any time after payment is indexed.
- [x] **Field-overflow mint vector** → `asset_amount.assert_max_bit_size::<128>()`,
      consistent with transfer/withdraw.
- [ ] **Merchant id squatting** → optional PoK at `registerMerchant` (decide).
- [ ] **Privacy leak (merchant side)** → a registered `merchantId` is public, so
      all sales to it are linkable. Acceptable for a storefront; a merchant
      wanting per-listing unlinkability can register a fresh id per listing.

---

## 9. Build / test plan

- **Circuit unit tests** (`nargo test`): happy path; wrong recipient_hash
  (`should_fail`); membership against wrong root (`should_fail`).
- **Hardhat tests** (`contracts/test`): register → list → pay (Pampalo
  `transfer`) → redeem happy path; double `redeem` reverts; wrong
  amount/asset/merchant/listing reverts; recipient-swap reverts (proof invalid);
  unknown-root reverts; cancelled/closed listing reverts; escrow return on cancel.
- **Shared prover test**: `Redeem.ts` produces a proof the deployed
  `RedeemVerifier` accepts (end-to-end witness from a real merkle mirror).

---

## 10. Phased delivery

1. **Circuit + lib**: `redeem` circuit, `REDEEM_DOMAIN` + `compute_redeem_nullifier`,
   `redeem.json`, `RedeemVerifier.sol`. Land with circuit tests.
2. **Contract**: `PampaloRedeemer.sol` + Hardhat tests + Ignition modules.
3. **Prover + indexer**: `Redeem.ts`, Convex schema tables + event indexing.
4. **Client UX**: pay → wait → redeem, editions-first.
5. **(Optional)** 1-of-1 reservations or the atomic path (Appendix A).

---

## Appendix A — Atomic alternative (`transferAndRedeem`)

Removes the settlement race by collapsing pay + deliver into one tx. The buyer
generates a normal `transfer` proof (spend their notes → one output note to the
merchant) **with `listing_id` + `recipient` bound in as extra public inputs**.
A combined entrypoint verifies it, inserts the merchant's output leaf, and
delivers the NFT in the same call. Cost ≈ transfer verify + leaf insert + ERC-721
transfer ≈ **~0.7–1.2M gas** — not "tens of millions."

Tradeoff: it reuses the `transfer` circuit almost as-is (cheaper circuit work
than a new membership circuit) but is **more invasive on-chain** — the entrypoint
must be able to insert leaves into the Pampalo tree, so it's either a new
`Pampalo` method or a privileged leaf-inserter role grant, rather than a
standalone contract that only reads `isKnownRoot`. Pick this if "paid but didn't
receive" is unacceptable (true 1-of-1s); pick the two-step body of this document
if decoupling and flexible payment timing matter more.

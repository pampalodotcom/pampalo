// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./PoseidonMerkleTree.sol";
import {IVerifier} from "./verifiers/DepositVerifier.sol";

//                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//                      ~ pampalo private payments ~
//                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//
/// @title  PampaloPayments
/// @notice A permissionless settlement singleton that lets any contract
///         accept a Pampalo private payment the way it would accept an
///         ERC-20 transfer. It is the shared registry of redeem
///         nullifiers, so a single private payment can be settled at
///         most ONCE, ever, across every consuming contract.
///
///         The flow is two-step and non-atomic (model A):
///           1. Buyer pays a merchant out-of-band via a normal Pampalo
///              `transfer` -- creating one note owned by the merchant's
///              Poseidon identifier, worth (asset, amount). After the
///              paying tx is indexed the note has a leaf_index + merkle
///              path.
///           2. Buyer builds a `redeem` proof ("a note owned by
///              merchant_id, worth amount of asset, exists in a known
///              root") and the consuming contract calls `verifyAndBurn`
///              from inside its own purchase flow, delivering the good
///              atomically with the burn.
///
///         This contract NEVER moves value. The merchant already holds a
///         spendable note; `verifyAndBurn` only proves the payment landed
///         and burns its redeem nullifier. It reads roots from the live
///         Pampalo deployment via `isKnownRoot` and verifies via a
///         dedicated `RedeemVerifier` Honk verifier -- it does not touch,
///         and is not trusted by, the Pampalo core.
///
/// @dev    See the redeem circuit (`circuits/redeem/src/main.nr`) for the
///         public-input layout and the binding argument behind each
///         field. The `consumer` binding + the `msg.sender == consumer`
///         check below are what make the split verify-then-deliver safe
///         against a mempool watcher burning the nullifier without
///         delivering (a DoS the atomic Pampalo paths can't suffer).
contract PampaloPayments {
  // ──────────────────────────────────────────────────────────────────────
  // Wiring
  // ──────────────────────────────────────────────────────────────────────

  PoseidonMerkleTree public immutable pampalo;
  IVerifier public immutable redeemVerifier;

  // The shared, append-only set of spent redeem nullifiers. A note's
  // redeem nullifier is domain-separated from its spend nullifier (the
  // merchant can still spend the note normally), so burning here does
  // not grief the merchant and vice versa.
  mapping(bytes32 => bool) public redeemNullifierUsed;

  // ──────────────────────────────────────────────────────────────────────
  // Public-input layout (mirrors circuits/redeem/src/main.nr)
  // ──────────────────────────────────────────────────────────────────────

  uint256 constant PI_ROOT = 0;
  uint256 constant PI_NULLIFIER = 1;
  uint256 constant PI_MERCHANT = 2;
  uint256 constant PI_ASSET = 3;
  uint256 constant PI_AMOUNT = 4;
  uint256 constant PI_RECIPIENT = 5;
  uint256 constant PI_CONSUMER = 6;
  uint256 constant PI_REFERENCE = 7;

  event PrivatePaymentSettled(
    address indexed consumer,
    uint256 indexed merchantId,
    bytes32 redeemNullifier,
    address asset,
    uint256 amount,
    address recipient,
    bytes32 ref
  );

  constructor(PoseidonMerkleTree _pampalo, IVerifier _redeemVerifier) {
    pampalo = _pampalo;
    redeemVerifier = _redeemVerifier;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Settlement
  // ──────────────────────────────────────────────────────────────────────

  /// @notice Verify a private-payment proof and burn its redeem
  ///         nullifier. Reverts unless every bound public input matches
  ///         the caller's expectations and the note has not been redeemed
  ///         before. Intended to be called by a consuming contract from
  ///         inside its own purchase flow -- the caller (`msg.sender`)
  ///         MUST equal the `consumer` bound into the proof.
  /// @param  proof          the UltraHonk redeem proof
  /// @param  publicInputs   the bound public-input vector (see PI_* above)
  /// @param  merchantId     the Poseidon identifier the payment must be owned by
  /// @param  asset          the asset the payment must be denominated in
  /// @param  amount         the exact base-unit amount the payment must equal
  /// @param  recipient      the address the proof authorises delivery to
  /// @param  ref      the opaque consumer-defined binding (item id, ...)
  /// @return redeemNullifier the nullifier that was burned
  function verifyAndBurn(
    bytes calldata proof,
    bytes32[] calldata publicInputs,
    uint256 merchantId,
    address asset,
    uint256 amount,
    address recipient,
    bytes32 ref
  ) external returns (bytes32 redeemNullifier) {
    // 1. The root must be one Pampalo actually produced. Historical roots
    //    never expire, so the buyer may redeem any time after indexing.
    require(
      pampalo.isKnownRoot(uint256(publicInputs[PI_ROOT])),
      "Invalid Root!"
    );

    // 2. The proof must verify against the redeem verifier.
    require(
      redeemVerifier.verify(proof, publicInputs),
      "Invalid redeem proof"
    );

    // 3. Only the bound consumer may settle this proof. Without this a
    //    mempool watcher could copy (proof, publicInputs) and burn the
    //    nullifier directly, stranding the payer's note forever.
    require(
      address(uint160(uint256(publicInputs[PI_CONSUMER]))) == msg.sender,
      "consumer mismatch"
    );

    // 4. Bind the remaining public inputs to the caller's expectations.
    require(
      uint256(publicInputs[PI_MERCHANT]) == merchantId,
      "merchant mismatch"
    );
    require(
      address(uint160(uint256(publicInputs[PI_ASSET]))) == asset,
      "asset mismatch"
    );
    require(uint256(publicInputs[PI_AMOUNT]) == amount, "amount mismatch");
    require(
      address(uint160(uint256(publicInputs[PI_RECIPIENT]))) == recipient,
      "recipient mismatch"
    );
    require(publicInputs[PI_REFERENCE] == ref, "ref mismatch");

    // 5. Global single-use: burn the redeem nullifier.
    redeemNullifier = publicInputs[PI_NULLIFIER];
    require(!redeemNullifierUsed[redeemNullifier], "Already redeemed");
    redeemNullifierUsed[redeemNullifier] = true;

    emit PrivatePaymentSettled(
      msg.sender,
      merchantId,
      redeemNullifier,
      asset,
      amount,
      recipient,
      ref
    );
  }
}

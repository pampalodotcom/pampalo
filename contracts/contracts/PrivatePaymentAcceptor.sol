// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PampaloPayments} from "./PampaloPayments.sol";

/// @title  PrivatePaymentAcceptor
/// @notice Inheritable base that lets a contract accept a Pampalo private
///         payment the same way it accepts an ERC-20 -- one line at the
///         top of a purchase flow:
///
///           function purchase(uint256 itemId, bool usePrivate, bytes calldata proof, bytes32[] calldata publicInputs) external {
///             _acceptPayment(
///               usePrivate,
///               proof, publicInputs,
///               asset, prices[itemId], msg.sender, bytes32(itemId)
///             );
///             _deliver(itemId, msg.sender);
///           }
///
///         The deploying vendor owns a `privateEnabled` switch: while it
///         is off, the private branch reverts and only the public ERC-20
///         branch works. Merchant identity is the vendor's own config
///         (`merchantId`) -- buyers pay a note to that Poseidon identifier
///         and the bound proof is checked against it.
///
/// @dev    `merchantId` is set at construction and may be rotated by the
///         admin (existing un-redeemed payments to the old id become
///         unredeemable, so rotate deliberately). The base never holds the
///         envelope key: that only matters on the payment side so the
///         merchant can decrypt + later spend the note, which is ordinary
///         Pampalo transfer machinery, not part of this proof.
abstract contract PrivatePaymentAcceptor {
  PampaloPayments public immutable pampaloPayments;

  /// The Poseidon identifier private payments must be owned by.
  uint256 public merchantId;

  /// Vendor kill switch for the private-payment path. Public ERC-20
  /// payments are unaffected.
  bool public privateEnabled;

  /// The address allowed to toggle `privateEnabled` / rotate merchantId.
  address public privatePaymentAdmin;

  event PrivatePaymentsToggled(bool enabled);
  event MerchantIdUpdated(uint256 merchantId);
  event PrivatePaymentAdminTransferred(address indexed from, address indexed to);

  constructor(
    PampaloPayments _pampaloPayments,
    uint256 _merchantId,
    address _admin
  ) {
    require(address(_pampaloPayments) != address(0), "payments zero");
    require(_admin != address(0), "admin zero");
    pampaloPayments = _pampaloPayments;
    merchantId = _merchantId;
    privateEnabled = true;
    privatePaymentAdmin = _admin;
    emit MerchantIdUpdated(_merchantId);
    emit PrivatePaymentsToggled(true);
  }

  modifier onlyPrivatePaymentAdmin() {
    require(msg.sender == privatePaymentAdmin, "not private payment admin");
    _;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Vendor admin
  // ──────────────────────────────────────────────────────────────────────

  /// @notice Turn private payments on/off. The disable any vendor asked
  ///         for: while off, `_acceptPrivatePayment` reverts.
  function setPrivatePaymentsEnabled(bool enabled)
    external
    onlyPrivatePaymentAdmin
  {
    privateEnabled = enabled;
    emit PrivatePaymentsToggled(enabled);
  }

  function setMerchantId(uint256 _merchantId)
    external
    onlyPrivatePaymentAdmin
  {
    merchantId = _merchantId;
    emit MerchantIdUpdated(_merchantId);
  }

  function transferPrivatePaymentAdmin(address newAdmin)
    external
    onlyPrivatePaymentAdmin
  {
    require(newAdmin != address(0), "admin zero");
    emit PrivatePaymentAdminTransferred(privatePaymentAdmin, newAdmin);
    privatePaymentAdmin = newAdmin;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Acceptance helpers (called from the vendor's purchase flow)
  // ──────────────────────────────────────────────────────────────────────

  /// @notice Settle a private payment: gate on the kill switch, then have
  ///         the singleton verify the proof + burn the redeem nullifier.
  ///         The proof's bound `consumer` must be this contract (enforced
  ///         by the singleton via `msg.sender`), so this can only succeed
  ///         from inside this contract's own call.
  function _acceptPrivatePayment(
    bytes calldata proof,
    bytes32[] calldata publicInputs,
    address asset,
    uint256 amount,
    address recipient,
    bytes32 ref
  ) internal {
    require(privateEnabled, "private payments disabled");
    pampaloPayments.verifyAndBurn(
      proof,
      publicInputs,
      merchantId,
      asset,
      amount,
      recipient,
      ref
    );
  }

  /// @notice One-liner that mirrors a standard "take payment" call: either
  ///         settle a private payment (proof of a prior Pampalo transfer)
  ///         or pull a public ERC-20 transfer from `payer`. `recipient` is
  ///         the delivery target bound into the private proof (ignored on
  ///         the public branch).
  function _acceptPayment(
    bool usePrivate,
    bytes calldata proof,
    bytes32[] calldata publicInputs,
    address asset,
    uint256 amount,
    address recipient,
    address payer,
    bytes32 ref
  ) internal {
    if (usePrivate) {
      _acceptPrivatePayment(
        proof,
        publicInputs,
        asset,
        amount,
        recipient,
        ref
      );
    } else {
      require(
        IERC20(asset).transferFrom(payer, address(this), amount),
        "public payment failed"
      );
    }
  }
}

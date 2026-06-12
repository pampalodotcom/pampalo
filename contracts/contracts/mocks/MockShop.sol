// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrivatePaymentAcceptor} from "../PrivatePaymentAcceptor.sol";
import {PampaloPayments} from "../PampaloPayments.sol";

/// @title  MockShop
/// @notice A minimal storefront exercising `PrivatePaymentAcceptor`. It
///         sells priced items payable either by a public ERC-20 transfer
///         or by proving a prior Pampalo private payment. Delivery is just
///         a recorded event/counter -- the point is the payment plumbing,
///         not an NFT/ERC-20 reward implementation.
contract MockShop is PrivatePaymentAcceptor {
  address public immutable payAsset;
  mapping(uint256 => uint256) public prices; // itemId => base-unit price
  mapping(uint256 => uint256) public sold; // itemId => units delivered

  event Delivered(
    uint256 indexed itemId,
    address indexed recipient,
    bool usePrivate
  );

  constructor(
    PampaloPayments _payments,
    uint256 _merchantId,
    address _admin,
    address _payAsset
  ) PrivatePaymentAcceptor(_payments, _merchantId, _admin) {
    payAsset = _payAsset;
  }

  function setPrice(uint256 itemId, uint256 price)
    external
    onlyPrivatePaymentAdmin
  {
    prices[itemId] = price;
  }

  /// @notice Buy `itemId`. Private payers pass a redeem proof bound to
  ///         (recipient = msg.sender, consumer = this shop, reference =
  ///         itemId). Public payers must have approved this shop for the
  ///         price in `payAsset`.
  function purchase(
    uint256 itemId,
    bool usePrivate,
    bytes calldata proof,
    bytes32[] calldata publicInputs
  ) external {
    require(prices[itemId] > 0, "item not for sale");

    if (usePrivate) {
      _acceptPrivatePayment(
        proof,
        publicInputs,
        payAsset,
        prices[itemId],
        msg.sender, // recipient bound in the private proof
        bytes32(itemId) // reference
      );
    } else {
      require(
        IERC20(payAsset).transferFrom(
          msg.sender,
          address(this),
          prices[itemId]
        ),
        "public payment failed"
      );
    }

    sold[itemId] += 1;
    emit Delivered(itemId, msg.sender, usePrivate);
  }
}

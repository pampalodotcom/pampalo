// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PampaloSwapBase} from "./PampaloSwapBase.sol";
import {IV3SwapRouter} from "./interfaces/IV3SwapRouter.sol";

/// @title  PampaloSwapV3
/// @notice Uniswap v3 venue adapter for private swaps. Routes the trade
///         through SwapRouter02's `exactInput` over a packed path. The
///         contract holds the pooled funds, so it approves the router for
///         its own tokens per-swap (no standing allowance, no admin step).
contract PampaloSwapV3 is PampaloSwapBase {
  using SafeERC20 for IERC20;

  /// @notice Uniswap SwapRouter02.
  address public immutable swapRouter;

  constructor(
    address _depositVerifier,
    address _transferVerifier,
    address _withdrawVerifier,
    address _transferExternalVerifier,
    address _swapRouter,
    address _swapVerifier
  )
    PampaloSwapBase(
      _depositVerifier,
      _transferVerifier,
      _withdrawVerifier,
      _transferExternalVerifier,
      _swapVerifier
    )
  {
    swapRouter = _swapRouter;
  }

  /// @inheritdoc PampaloSwapBase
  /// @dev `route` is a v3 packed path: `tokenIn(20) || fee(3) ||
  ///      tokenOut(20) [ || fee(3) || token(20) … ]`. We bind the path's
  ///      first/last 20 bytes to inputAsset/outputAsset, then let the
  ///      router enforce the floor (`amountOutMinimum = minOut`).
  function _executeSwap(
    address inputAsset,
    uint256 inputAmount,
    address outputAsset,
    uint256 minOut,
    bytes calldata route
  ) internal override returns (uint256 realized) {
    // Single hop is 43 bytes (20 + 3 + 20); each extra hop adds 23
    // (3 + 20). So a valid path is 20 + k*23 for k >= 1.
    require(route.length >= 43 && (route.length - 20) % 23 == 0, "bad v3 path");

    address pathIn = address(bytes20(route[0:20]));
    address pathOut = address(bytes20(route[route.length - 20:route.length]));
    require(pathIn == inputAsset, "v3 path input mismatch");
    require(pathOut == outputAsset, "v3 path output mismatch");

    // Per-swap exact approval of the router for our own pooled tokens.
    IERC20(inputAsset).forceApprove(swapRouter, inputAmount);

    realized = IV3SwapRouter(swapRouter).exactInput(
      IV3SwapRouter.ExactInputParams({
        path: route,
        recipient: address(this),
        amountIn: inputAmount,
        amountOutMinimum: minOut
      })
    );

    // Drop any residual allowance (exact-input should consume it all,
    // but a router that pulls less would otherwise leave a dangling
    // approval on our pooled funds).
    IERC20(inputAsset).forceApprove(swapRouter, 0);
  }
}

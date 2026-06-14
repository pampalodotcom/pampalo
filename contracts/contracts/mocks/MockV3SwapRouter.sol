// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IV3SwapRouter} from "../interfaces/IV3SwapRouter.sol";

/// @title  MockV3SwapRouter
/// @notice Test-only SwapRouter02 stand-in. Pulls `amountIn` of the
///         path's first token from the caller, pays out
///         `amountIn * outPerInWad / 1e18` of the path's last token from
///         its own pre-funded balance, and reverts with "Too little
///         received" when that falls below `amountOutMinimum` — mirroring
///         the real router's floor revert. Only single-hop paths are
///         decoded (enough for mechanics tests).
contract MockV3SwapRouter is IV3SwapRouter {
  using SafeERC20 for IERC20;

  // Output tokens per 1 input token, scaled by 1e18.
  uint256 public outPerInWad = 1e18;

  function setRate(uint256 _outPerInWad) external {
    outPerInWad = _outPerInWad;
  }

  function exactInput(ExactInputParams calldata params)
    external
    payable
    override
    returns (uint256 amountOut)
  {
    bytes calldata path = params.path;
    address tokenIn = address(bytes20(path[0:20]));
    address tokenOut = address(bytes20(path[path.length - 20:path.length]));

    IERC20(tokenIn).safeTransferFrom(
      msg.sender,
      address(this),
      params.amountIn
    );

    amountOut = (params.amountIn * outPerInWad) / 1e18;
    require(amountOut >= params.amountOutMinimum, "Too little received");

    IERC20(tokenOut).safeTransfer(params.recipient, amountOut);
  }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Minimal slice of Uniswap's SwapRouter02 (`exactInput`) — the
///         only entrypoint PampaloSwapV3 needs. SwapRouter02 dropped the
///         `deadline` field that the original v3 SwapRouter carried, so
///         `ExactInputParams` here has four fields, not five.
///
///         Vendored as a local interface because pampalo's contracts
///         package depends only on OpenZeppelin contracts; pulling the
///         full Uniswap swap-router-contracts package in would be a
///         heavier dependency than this one struct + selector warrants.
interface IV3SwapRouter {
  struct ExactInputParams {
    bytes path;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
  }

  /// @notice Swaps `amountIn` of the first token in `path` for as much as
  ///         possible of the last token, reverting if the realized output
  ///         is below `amountOutMinimum` ("Too little received").
  function exactInput(ExactInputParams calldata params)
    external
    payable
    returns (uint256 amountOut);
}

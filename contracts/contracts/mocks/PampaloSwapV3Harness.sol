// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {PampaloSwapV3} from "../PampaloSwapV3.sol";

/// @title  PampaloSwapV3Harness
/// @notice Test-only subclass exposing `_insert` so round-trip tests can
///         seed a note directly into the tree without the full shield
///         flow. Never deploy this.
contract PampaloSwapV3Harness is PampaloSwapV3 {
  constructor(
    address _depositVerifier,
    address _transferVerifier,
    address _withdrawVerifier,
    address _transferExternalVerifier,
    address _swapRouter,
    address _swapVerifier
  )
    PampaloSwapV3(
      _depositVerifier,
      _transferVerifier,
      _withdrawVerifier,
      _transferExternalVerifier,
      _swapRouter,
      _swapVerifier
    )
  {}

  function harnessInsert(uint256 leaf) external returns (uint256) {
    return _insert(leaf);
  }
}

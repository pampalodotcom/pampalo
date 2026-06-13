// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {PampaloSwapV4} from "../PampaloSwapV4.sol";

/// @title  PampaloSwapV4Harness
/// @notice Test-only subclass exposing `_insert` so round-trip tests can
///         seed a note directly into the tree without the full shield
///         flow. Never deploy this.
contract PampaloSwapV4Harness is PampaloSwapV4 {
  constructor(
    address _depositVerifier,
    address _transferVerifier,
    address _withdrawVerifier,
    address _transferExternalVerifier,
    address _poolManager,
    address _swapVerifier
  )
    PampaloSwapV4(
      _depositVerifier,
      _transferVerifier,
      _withdrawVerifier,
      _transferExternalVerifier,
      _poolManager,
      _swapVerifier
    )
  {}

  function harnessInsert(uint256 leaf) external returns (uint256) {
    return _insert(leaf);
  }
}

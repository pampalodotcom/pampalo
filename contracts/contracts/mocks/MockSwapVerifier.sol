// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IVerifier} from "../verifiers/DepositVerifier.sol";

/// @title  MockSwapVerifier
/// @notice Test-only IVerifier whose `verify` returns a configurable
///         result, so swap *mechanics* tests can drive PampaloSwapBase
///         without generating a real Honk proof. Round-trip tests use
///         the real generated SwapVerifier instead.
contract MockSwapVerifier is IVerifier {
  bool public result = true;

  function setResult(bool _result) external {
    result = _result;
  }

  function verify(bytes calldata, bytes32[] calldata)
    external
    view
    override
    returns (bool)
  {
    return result;
  }
}

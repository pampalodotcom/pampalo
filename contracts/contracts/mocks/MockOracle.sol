// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPriceOracle} from "../oracles/IPriceOracle.sol";

/// @title  MockOracle
/// @notice Test-only IPriceOracle that returns a static USD price per
///         underlying unit. Used by Hardhat tests so we don't depend
///         on a live Chainlink feed. Set `staleness` non-zero to
///         simulate a stale feed (reverts on read).
contract MockOracle is IPriceOracle {
  uint256 public priceUsdCentsPerUnit;
  bool public isStale;

  constructor(uint256 _priceUsdCentsPerUnit) {
    priceUsdCentsPerUnit = _priceUsdCentsPerUnit;
  }

  function setPrice(uint256 _priceUsdCentsPerUnit) external {
    priceUsdCentsPerUnit = _priceUsdCentsPerUnit;
  }

  function setStale(bool _isStale) external {
    isStale = _isStale;
  }

  function priceUsdCents(uint256 amount, uint8 assetDecimals)
    external
    view
    returns (uint256)
  {
    require(!isStale, "MockOracle: stale price");
    return (amount * priceUsdCentsPerUnit) / (10 ** uint256(assetDecimals));
  }
}

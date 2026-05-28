// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPriceOracle} from "./IPriceOracle.sol";

interface AggregatorV3Interface {
  function decimals() external view returns (uint8);
  function latestRoundData()
    external
    view
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    );
}

/// @title  ChainlinkOracle
/// @notice IPriceOracle adapter for a single Chainlink AggregatorV3
///         feed. The feed address and staleness window are pinned at
///         construction time; rotating either means deploying a fresh
///         adapter and re-registering via
///         `Pampalo.addSupportedAsset`.
contract ChainlinkOracle is IPriceOracle {
  AggregatorV3Interface public immutable feed;
  uint32 public immutable maxAge;
  uint8 public immutable feedDecimals;

  /// @param _feed   Chainlink AggregatorV3 feed for ASSET/USD.
  /// @param _maxAge Staleness threshold in seconds. Reverts if the
  ///                feed's `updatedAt` is older than this. Per-pair
  ///                heartbeats vary widely (mainnet ETH/USD: 1 hour;
  ///                some less-liquid pairs: 24 hours).
  constructor(address _feed, uint32 _maxAge) {
    feed = AggregatorV3Interface(_feed);
    maxAge = _maxAge;
    feedDecimals = AggregatorV3Interface(_feed).decimals();
  }

  function priceUsdCents(uint256 amount, uint8 assetDecimals)
    external
    view
    returns (uint256)
  {
    (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
    require(answer > 0, "ChainlinkOracle: non-positive price");
    require(
      block.timestamp <= updatedAt + maxAge,
      "ChainlinkOracle: stale price"
    );

    // amount has `assetDecimals` decimals. Price has `feedDecimals`
    // decimals. We want USD cents (2 decimals). So:
    //   cents = amount * price * 100 / (10^assetDecimals * 10^feedDecimals)
    uint256 price = uint256(answer);
    uint256 scale = 10 ** uint256(assetDecimals) * 10 ** uint256(feedDecimals);
    return (amount * price * 100) / scale;
  }
}

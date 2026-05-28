// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title  IPriceOracle
/// @notice Pampalo's pluggable price-oracle adapter interface. One
///         adapter contract per supported asset. Pampalo itself stays
///         oracle-agnostic — Chainlink is the v1 default, but future
///         providers (Pyth, RedStone, on-chain TWAPs) ship as new
///         adapter contracts implementing this same interface and get
///         registered against an asset via
///         `Pampalo.addSupportedAsset`.
///
///         Adapters MUST revert on stale data, non-positive prices,
///         or any other condition that would produce a misleading USD
///         value. Staleness semantics are adapter-internal because
///         they differ per provider (Chainlink uses `updatedAt`, Pyth
///         uses publish time, etc.).
interface IPriceOracle {
  /// @notice Convert `amount` of the underlying asset into USD cents
  ///         (i.e. 100 = $1.00). Adapters are responsible for handling
  ///         their own feed-decimals + asset-decimals scaling.
  /// @param amount         Quantity of the asset in its native units
  ///                       (wei for ETH, 6-decimal base units for
  ///                       USDC, etc).
  /// @param assetDecimals  Decimals of the underlying asset. Pampalo
  ///                       passes this from its `AssetConfig`.
  function priceUsdCents(uint256 amount, uint8 assetDecimals)
    external
    view
    returns (uint256);
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// Minimal Uniswap v4 surface used by PampaloSwapV4. Vendored locally
// (pampalo's contracts package depends only on @openzeppelin/contracts)
// and kept to exactly what the adapter touches: unlock/callback,
// `swap`, and the flash-accounting settle/sync/take trio. The types
// mirror v4-core's layout (Currency is an address-typed user value,
// BalanceDelta packs two int128s into an int256). Verify these against
// the v4-core version you deploy against before going to mainnet.

type Currency is address;

type BalanceDelta is int256;

struct PoolKey {
  Currency currency0;
  Currency currency1;
  uint24 fee;
  int24 tickSpacing;
  address hooks;
}

struct SwapParams {
  bool zeroForOne;
  int256 amountSpecified;
  uint160 sqrtPriceLimitX96;
}

/// @notice The lock-acquiring callback v4's PoolManager invokes on the
///         address that called `unlock`.
interface IUnlockCallback {
  function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IPoolManager {
  /// @notice Acquires a lock and calls back `unlockCallback` on the
  ///         caller; the call must leave the manager's currency deltas
  ///         net-zero by the time it returns.
  function unlock(bytes calldata data) external returns (bytes memory);

  /// @notice Executes a swap against `key`. Negative `amountSpecified`
  ///         means exact-input. Returns the caller's balance delta.
  function swap(
    PoolKey calldata key,
    SwapParams calldata params,
    bytes calldata hookData
  ) external returns (BalanceDelta);

  /// @notice Begins settlement of `currency`: records the manager's
  ///         current reserve so the subsequent `settle` can credit the
  ///         transferred-in amount.
  function sync(Currency currency) external;

  /// @notice Pays whatever the caller owes the manager (measured against
  ///         the last `sync`), returning the paid amount.
  function settle() external payable returns (uint256 paid);

  /// @notice Withdraws `amount` of `currency` from the manager to `to`,
  ///         debiting the caller's delta.
  function take(Currency currency, address to, uint256 amount) external;
}

/// @dev BalanceDelta packs amount0 in the high 128 bits and amount1 in
///      the low 128 bits, each a signed int128 (positive = the manager
///      owes the caller, negative = the caller owes the manager).
library BalanceDeltaLibrary {
  function amount0(BalanceDelta delta) internal pure returns (int128) {
    return int128(BalanceDelta.unwrap(delta) >> 128);
  }

  function amount1(BalanceDelta delta) internal pure returns (int128) {
    return int128(int256(BalanceDelta.unwrap(delta)));
  }
}

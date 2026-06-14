// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PampaloSwapBase} from "./PampaloSwapBase.sol";
import {
  IPoolManager,
  IUnlockCallback,
  PoolKey,
  SwapParams,
  BalanceDelta,
  BalanceDeltaLibrary,
  Currency
} from "./interfaces/IUniswapV4.sol";

/// @title  PampaloSwapV4
/// @notice Uniswap v4 venue adapter for private swaps. Trades through the
///         singleton PoolManager via the unlock/callback + flash-
///         accounting pattern: acquire a lock, run one or more exact-
///         input hops, then settle only the first input and take only the
///         last output — intermediate legs net to zero inside the lock.
contract PampaloSwapV4 is PampaloSwapBase, IUnlockCallback {
  using SafeERC20 for IERC20;
  using BalanceDeltaLibrary for BalanceDelta;

  /// @notice Uniswap v4 PoolManager (singleton).
  IPoolManager public immutable poolManager;

  // v4 price-limit sentinels (one tick inside the usable range) so an
  // exact-input swap fills as much as possible without a price cap.
  uint160 private constant MIN_SQRT_RATIO = 4295128739;
  uint160 private constant MAX_SQRT_RATIO =
    1461446703485210103287273052203988822378723970342;

  /// @dev One pool to route through, plus the direction to trade it.
  struct Hop {
    PoolKey key;
    bool zeroForOne;
  }

  /// @dev Carried from `_executeSwap` into `unlockCallback` through the
  ///      PoolManager's opaque `unlock` data argument.
  struct SwapJob {
    address inputAsset;
    uint256 inputAmount;
    address outputAsset;
    uint256 minOut;
    Hop[] hops;
  }

  constructor(
    address _depositVerifier,
    address _transferVerifier,
    address _withdrawVerifier,
    address _transferExternalVerifier,
    address _poolManager,
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
    poolManager = IPoolManager(_poolManager);
  }

  /// @inheritdoc PampaloSwapBase
  /// @dev `route` is `abi.encode(Hop[])`. Decodes the hops, hands them to
  ///      the PoolManager unlock, and reads back the realized output.
  function _executeSwap(
    address inputAsset,
    uint256 inputAmount,
    address outputAsset,
    uint256 minOut,
    bytes calldata route
  ) internal override returns (uint256 realized) {
    Hop[] memory hops = abi.decode(route, (Hop[]));
    require(hops.length >= 1, "no hops");

    bytes memory result = poolManager.unlock(
      abi.encode(
        SwapJob({
          inputAsset: inputAsset,
          inputAmount: inputAmount,
          outputAsset: outputAsset,
          minOut: minOut,
          hops: hops
        })
      )
    );
    realized = abi.decode(result, (uint256));
  }

  /// @notice PoolManager lock callback. Only the manager may call.
  function unlockCallback(bytes calldata data)
    external
    override
    returns (bytes memory)
  {
    require(msg.sender == address(poolManager), "not pool manager");

    SwapJob memory job = abi.decode(data, (SwapJob));

    // First hop's input currency is bound to the proof's inputAsset.
    Hop memory first = job.hops[0];
    Currency inputCurrency = first.zeroForOne
      ? first.key.currency0
      : first.key.currency1;
    require(
      Currency.unwrap(inputCurrency) == job.inputAsset,
      "v4 input currency mismatch"
    );

    // Chain exact-input hops. flash accounting nets the intermediates,
    // so we only ever settle the first input and take the last output.
    uint256 currentAmount = job.inputAmount;
    Currency runningInput = inputCurrency;
    Currency outputCurrency;

    for (uint256 i = 0; i < job.hops.length; i++) {
      Hop memory hop = job.hops[i];

      Currency hopIn = hop.zeroForOne ? hop.key.currency0 : hop.key.currency1;
      Currency hopOut = hop.zeroForOne ? hop.key.currency1 : hop.key.currency0;

      // Each hop must consume what the previous produced.
      require(
        Currency.unwrap(hopIn) == Currency.unwrap(runningInput),
        "v4 hop input mismatch"
      );

      BalanceDelta delta = poolManager.swap(
        hop.key,
        SwapParams({
          zeroForOne: hop.zeroForOne,
          // Negative = exact input.
          amountSpecified: -int256(currentAmount),
          sqrtPriceLimitX96: hop.zeroForOne
            ? MIN_SQRT_RATIO + 1
            : MAX_SQRT_RATIO - 1
        }),
        ""
      );

      // The output currency's delta is positive (the manager owes us).
      int128 outDelta = hop.zeroForOne ? delta.amount1() : delta.amount0();
      require(outDelta > 0, "v4 non-positive output");
      currentAmount = uint256(uint128(outDelta));

      runningInput = hopOut;
      outputCurrency = hopOut;
    }

    // Last hop's output currency is bound to the proof's outputAsset.
    require(
      Currency.unwrap(outputCurrency) == job.outputAsset,
      "v4 output currency mismatch"
    );

    // Slippage / sandwich floor.
    require(currentAmount >= job.minOut, "slippage / sandwich floor");

    // Settle only the first input: pay the manager what we owe.
    poolManager.sync(inputCurrency);
    IERC20(job.inputAsset).safeTransfer(
      address(poolManager),
      job.inputAmount
    );
    poolManager.settle();

    // Take only the last output.
    poolManager.take(outputCurrency, address(this), currentAmount);

    return abi.encode(currentAmount);
  }
}

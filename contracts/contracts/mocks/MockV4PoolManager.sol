// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
  IPoolManager,
  IUnlockCallback,
  PoolKey,
  SwapParams,
  BalanceDelta,
  Currency
} from "../interfaces/IUniswapV4.sol";

/// @title  MockV4PoolManager
/// @notice Test-only v4 PoolManager stand-in implementing just enough of
///         the unlock / swap / sync / settle / take flow for
///         PampaloSwapV4 mechanics tests. Each `swap` returns a packed
///         BalanceDelta (input owed, output owed-to-caller) at the
///         configured rate; the manager pays out `take` from its own
///         pre-funded balance. Net-zero accounting is not enforced (a
///         mock, not the real singleton).
contract MockV4PoolManager is IPoolManager {
  using SafeERC20 for IERC20;

  uint256 public outPerInWad = 1e18;

  Currency private syncedCurrency;
  uint256 private syncedBalance;

  function setRate(uint256 _outPerInWad) external {
    outPerInWad = _outPerInWad;
  }

  function unlock(bytes calldata data) external override returns (bytes memory) {
    return IUnlockCallback(msg.sender).unlockCallback(data);
  }

  function swap(
    PoolKey calldata,
    SwapParams calldata params,
    bytes calldata
  ) external view override returns (BalanceDelta) {
    require(params.amountSpecified < 0, "mock: exact-input only");
    uint256 inAmount = uint256(-params.amountSpecified);
    uint256 outAmount = (inAmount * outPerInWad) / 1e18;

    int128 a0;
    int128 a1;
    if (params.zeroForOne) {
      a0 = -int128(int256(inAmount));
      a1 = int128(int256(outAmount));
    } else {
      a1 = -int128(int256(inAmount));
      a0 = int128(int256(outAmount));
    }
    return _toBalanceDelta(a0, a1);
  }

  function sync(Currency currency) external override {
    syncedCurrency = currency;
    syncedBalance = _balance(currency);
  }

  function settle() external payable override returns (uint256 paid) {
    paid = _balance(syncedCurrency) - syncedBalance;
  }

  function take(Currency currency, address to, uint256 amount)
    external
    override
  {
    IERC20(Currency.unwrap(currency)).safeTransfer(to, amount);
  }

  function _balance(Currency currency) internal view returns (uint256) {
    return IERC20(Currency.unwrap(currency)).balanceOf(address(this));
  }

  function _toBalanceDelta(int128 a0, int128 a1)
    internal
    pure
    returns (BalanceDelta delta)
  {
    assembly {
      delta := or(
        shl(128, a0),
        and(a1, 0xffffffffffffffffffffffffffffffff)
      )
    }
  }
}

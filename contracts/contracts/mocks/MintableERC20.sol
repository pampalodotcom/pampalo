// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  MintableERC20
/// @notice Test-only ERC20 with open mint and configurable decimals —
///         used as a WETH stand-in (18 decimals) in swap mechanics
///         tests where the real WETH/forked liquidity isn't available.
contract MintableERC20 is ERC20 {
  uint8 private immutable _decimals;

  constructor(string memory name_, string memory symbol_, uint8 decimals_)
    ERC20(name_, symbol_)
  {
    _decimals = decimals_;
  }

  function decimals() public view override returns (uint8) {
    return _decimals;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}

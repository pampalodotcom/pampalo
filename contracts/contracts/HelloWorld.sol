// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title HelloWorld
/// @notice Smoke-test contract — proves the toolchain (Hardhat 3 +
/// Ignition + ethers v6 + mocha) is wired up end-to-end. Replace
/// with real contracts as the on-chain side of Pampalo lands.
contract HelloWorld {
    string public greeting;

    event GreetingChanged(string previous, string next, address by);

    constructor() {
        greeting = "Hello, Pampalo";
    }

    function setGreeting(string calldata next) external {
        emit GreetingChanged(greeting, next, msg.sender);
        greeting = next;
    }
}

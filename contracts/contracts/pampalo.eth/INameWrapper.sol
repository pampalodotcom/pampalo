// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title  INameWrapper
/// @notice Slim local interface for the subset of the ENS NameWrapper
///         (mainnet 0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401) that the
///         Pampalo username registrar actually calls. Declared locally on
///         purpose: pulling in the ens-contracts package as a *compile*
///         dependency would force a second solc version (ENS targets an
///         older pragma than this package's 0.8.x). ENS itself is only ever
///         touched from TypeScript (via ABIs) in the fork test.
interface INameWrapper {
  /// @notice ERC-1155 owner of a wrapped node. Returns address(0) for an
  ///         unwrapped, non-existent, or expired name — which is exactly
  ///         the "is this username available?" check the registrar needs.
  function ownerOf(uint256 id) external view returns (address owner);

  /// @notice Packed record for a wrapped node. The registrar reads the
  ///         parent's `expiry` to cap child expiry (a subname can never
  ///         outlive its parent).
  function getData(uint256 id)
    external
    view
    returns (address owner, uint32 fuses, uint64 expiry);

  /// @notice Mint (or overwrite an expired) wrapped subname under a parent
  ///         the caller owns or is approved for, setting its owner +
  ///         resolver in one call.
  function setSubnodeRecord(
    bytes32 parentNode,
    string calldata label,
    address owner,
    address resolver,
    uint64 ttl,
    uint32 fuses,
    uint64 expiry
  ) external returns (bytes32 node);

  /// @notice Extend (or change fuses on) an existing child. Used by renew().
  function setChildFuses(
    bytes32 parentNode,
    bytes32 labelhash,
    uint32 fuses,
    uint64 expiry
  ) external;

  function isApprovedForAll(address account, address operator)
    external
    view
    returns (bool);
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title  IPampaloResolver
/// @notice The single privileged write the registrar makes into the
///         directory resolver at registration time. Kept separate from the
///         resolver's public read surface so the registrar only depends on
///         what it calls.
interface IPampaloResolver {
  /// @notice Write a username's public records. Authorised to the registrar
  ///         only; the resolver gates owner-initiated updates separately.
  /// @param node        namehash of `<label>.pampalo.eth`.
  /// @param envelopeKey  Uncompressed secp256k1 public key (0x04 || X || Y),
  ///                     the ECIES target a sender encrypts a note secret to.
  /// @param poseidonId   poseidon2([privKey]) over BN254 — the note owner.
  function setRecordsByRegistrar(
    bytes32 node,
    bytes calldata envelopeKey,
    bytes32 poseidonId
  ) external;
}

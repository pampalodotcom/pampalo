// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {INameWrapper} from "./INameWrapper.sol";
import {IPampaloResolver} from "./IPampaloResolver.sol";

/// @title  PampaloDirectoryResolver
/// @notice ENS resolver for *user* Pampalo usernames (`alice.pampalo.eth`).
///         Resolves a name to its owner's **Envelope key** + **Poseidon
///         identifier** — the two public values a sender needs to address a
///         private note. Deliberately implements NO `addr()`: this is a
///         private-money receiving handle, not a public-payment one, so it
///         never publishes the holder's EVM address. Website names
///         (`pampalo.eth`, `dev.pampalo.eth`) use the standard ENS
///         PublicResolver + contenthash instead — a different concern, a
///         different resolver. See ADR 0012.
contract PampaloDirectoryResolver is IPampaloResolver {
  /// @notice The NameWrapper this resolver trusts for ownership checks. Used
  ///         to authorise owner-initiated record updates.
  INameWrapper public immutable wrapper;

  /// @notice The only contract allowed to seed records at registration time.
  address public immutable registrar;

  mapping(bytes32 => bytes) private _envelopeKey;
  mapping(bytes32 => bytes32) private _poseidonId;

  /// @notice Interop text() keys, so generic ENS clients can read the same
  ///         records as hex strings without knowing our typed getters.
  string private constant ENVELOPE_TEXT_KEY = "eth.pampalo.envelope";
  string private constant POSEIDON_TEXT_KEY = "eth.pampalo.poseidon";

  event PampaloRecordsSet(bytes32 indexed node);

  constructor(INameWrapper _wrapper, address _registrar) {
    wrapper = _wrapper;
    registrar = _registrar;
  }

  // ── writes ────────────────────────────────────────────────────────────

  /// @inheritdoc IPampaloResolver
  function setRecordsByRegistrar(
    bytes32 node,
    bytes calldata envelopeKey,
    bytes32 poseidonId
  ) external override {
    require(msg.sender == registrar, "not registrar");
    _set(node, envelopeKey, poseidonId);
  }

  /// @notice Owner-initiated update: the current holder of the username NFT
  ///         can rotate their records (re-keyed wallet, or repoint after the
  ///         name changed hands).
  function setRecords(
    bytes32 node,
    bytes calldata envelopeKey,
    bytes32 poseidonId
  ) external {
    require(wrapper.ownerOf(uint256(node)) == msg.sender, "not name owner");
    _set(node, envelopeKey, poseidonId);
  }

  function _set(
    bytes32 node,
    bytes calldata envelopeKey,
    bytes32 poseidonId
  ) internal {
    _envelopeKey[node] = envelopeKey;
    _poseidonId[node] = poseidonId;
    emit PampaloRecordsSet(node);
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /// @notice Both records in one call — what the Pampalo client uses to
  ///         address a note after resolving `<name>.pampalo.eth`.
  function resolvePampalo(bytes32 node)
    external
    view
    returns (bytes memory envelopeKey, bytes32 poseidonId)
  {
    return (_envelopeKey[node], _poseidonId[node]);
  }

  function envelopeKeyOf(bytes32 node) external view returns (bytes memory) {
    return _envelopeKey[node];
  }

  function poseidonIdOf(bytes32 node) external view returns (bytes32) {
    return _poseidonId[node];
  }

  /// @notice ENS text() interop. Returns the two records as 0x-hex strings.
  function text(bytes32 node, string calldata key)
    external
    view
    returns (string memory)
  {
    bytes32 k = keccak256(bytes(key));
    if (k == keccak256(bytes(ENVELOPE_TEXT_KEY))) {
      return _toHex(_envelopeKey[node]);
    }
    if (k == keccak256(bytes(POSEIDON_TEXT_KEY))) {
      return _toHex(abi.encodePacked(_poseidonId[node]));
    }
    return "";
  }

  function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
    return
      interfaceID == 0x01ffc9a7 || // ERC-165
      interfaceID == 0x59d1d43c; // text(bytes32,string)
  }

  function _toHex(bytes memory data) internal pure returns (string memory) {
    bytes memory alphabet = "0123456789abcdef";
    bytes memory out = new bytes(2 + data.length * 2);
    out[0] = "0";
    out[1] = "x";
    for (uint256 i = 0; i < data.length; i++) {
      out[2 + i * 2] = alphabet[uint8(data[i]) >> 4];
      out[3 + i * 2] = alphabet[uint8(data[i]) & 0x0f];
    }
    return string(out);
  }
}

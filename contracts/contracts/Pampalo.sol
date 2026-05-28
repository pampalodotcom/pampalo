// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

import "./PoseidonMerkleTree.sol";
import {IVerifier} from "./verifiers/DepositVerifier.sol";

//                                                ☼
//                       .  .  .             .  .  .
//                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//                          ~ pampalo, on EVM ~
//                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//
/// @title  Pampalo
/// @notice ZK private-money protocol. Public ERC-20 (or native ETH)
///         enters the contract via `shield` / `shieldNative` and
///         becomes an unlinkable on-chain note in a Poseidon merkle
///         tree; the note's owner is identified by a Poseidon hash
///         of their secret key, not their EVM address. Holders spend
///         notes privately via `transfer`, or back into the public
///         layer via `unshield` / `unshieldBundled`.
contract Pampalo is PoseidonMerkleTree, AccessControlEnumerable {
  address public depositVerifier;
  address public transferVerifier;
  address public withdrawVerifier;
  address public transferExternalVerifier;

  mapping(bytes32 => bool) public nullifierUsed;

  event NullifierUsed(bytes32 indexed nullifier);
  event NotePayload(bytes encryptedNote);

  uint256 constant NOTES_INPUT_LENGTH = 3;
  uint256 constant EXIT_ASSET_START_INDEX = 4;
  uint256 constant EXIT_AMOUNT_START_INDEX = 7;
  uint256 constant EXIT_ADDRESSES_START_INDEX = 10;

  address public immutable ETH_ADDRESS =
    0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

  constructor(
    address _depositVerifier,
    address _transferVerifier,
    address _withdrawVerifier,
    address _transferExternalVerifier
  ) PoseidonMerkleTree() {
    depositVerifier = _depositVerifier;
    transferVerifier = _transferVerifier;
    withdrawVerifier = _withdrawVerifier;
    transferExternalVerifier = _transferExternalVerifier;

    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
  }

  // ──────────────────────────────────────────────────────────────────────
  // shield — public ERC-20 → private note
  // ──────────────────────────────────────────────────────────────────────

  function shield(
    address _erc20,
    uint256 _amount,
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes[] calldata _payload
  ) public {
    bool ok = IERC20(_erc20).transferFrom(msg.sender, address(this), _amount);
    require(ok, "failed to transfer shield");

    bool isValidProof = IVerifier(depositVerifier).verify(
      _proof,
      _publicInputs
    );
    require(isValidProof, "Invalid shield proof");

    require(
      _erc20 == address(uint160(uint256(_publicInputs[1]))),
      "ERC20 address mismatch"
    );
    require(_amount == uint256(_publicInputs[2]), "Amount mismatch");

    _insert(uint256(_publicInputs[0]));

    for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
      if (_payload[i].length != 0) {
        emit NotePayload(_payload[i]);
      }
    }
  }

  function shieldNative(
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes[] calldata _payload
  ) public payable {
    bool isValidProof = IVerifier(depositVerifier).verify(
      _proof,
      _publicInputs
    );
    require(isValidProof, "Invalid shield proof");

    require(
      ETH_ADDRESS == address(uint160(uint256(_publicInputs[1]))),
      "Asset mismatch (expected ETH_ADDRESS)"
    );
    require(msg.value == uint256(_publicInputs[2]), "msg.value mismatch");

    _insert(uint256(_publicInputs[0]));

    for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
      if (_payload[i].length != 0) {
        emit NotePayload(_payload[i]);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // transfer — private note(s) → private note(s)
  // ──────────────────────────────────────────────────────────────────────

  function transfer(
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes[] calldata _payload
  ) public {
    require(isKnownRoot(uint256(_publicInputs[0])), "Invalid Root!");

    bool isValidProof = IVerifier(transferVerifier).verify(
      _proof,
      _publicInputs
    );
    require(isValidProof, "Invalid transfer proof");

    for (uint256 i = 1; i < NOTES_INPUT_LENGTH + 1; i++) {
      if (_publicInputs[i] != bytes32(0)) {
        require(
          nullifierUsed[_publicInputs[i]] == false,
          "Nullifier already spent"
        );
        nullifierUsed[_publicInputs[i]] = true;
        emit NullifierUsed(_publicInputs[i]);
      }
    }

    for (
      uint256 i = NOTES_INPUT_LENGTH + 1;
      i < NOTES_INPUT_LENGTH + 1 + NOTES_INPUT_LENGTH;
      i++
    ) {
      if (_publicInputs[i] != bytes32(0)) {
        _insert(uint256(_publicInputs[i]));
      }
    }

    for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
      if (_payload[i].length != 0) {
        emit NotePayload(_payload[i]);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // unshield — private note(s) → public ERC-20/ETH (single recipient)
  // ──────────────────────────────────────────────────────────────────────

  function unshield(
    bytes calldata _proof,
    bytes32[] calldata _publicInputs
  ) public {
    require(isKnownRoot(uint256(_publicInputs[0])), "Invalid Root!");

    bool isValidProof = IVerifier(withdrawVerifier).verify(
      _proof,
      _publicInputs
    );
    require(isValidProof, "Invalid unshield proof");

    for (uint256 i = 1; i <= NOTES_INPUT_LENGTH; i++) {
      if (_publicInputs[i] != bytes32(0)) {
        require(
          nullifierUsed[_publicInputs[i]] == false,
          "Nullifier already spent"
        );
        nullifierUsed[_publicInputs[i]] = true;
        emit NullifierUsed(_publicInputs[i]);
      }
    }

    for (uint256 i = 0; i < NOTES_INPUT_LENGTH; i++) {
      uint256 assetIndex = EXIT_ASSET_START_INDEX + i;
      uint256 amountIndex = EXIT_AMOUNT_START_INDEX + i;
      uint256 addressIndex = EXIT_ADDRESSES_START_INDEX + i;

      address exitAsset = address(uint160(uint256(_publicInputs[assetIndex])));
      uint256 exitAmount = uint256(_publicInputs[amountIndex]);
      address exitAddress = address(
        uint160(uint256(_publicInputs[addressIndex]))
      );

      if (exitAmount > 0) {
        if (exitAsset == ETH_ADDRESS) {
          require(
            address(this).balance >= exitAmount,
            "Insufficient ETH balance"
          );
          (bool success, ) = exitAddress.call{value: exitAmount}("");
          require(success, "ETH transfer failed");
        } else {
          bool success = IERC20(exitAsset).transfer(exitAddress, exitAmount);
          require(success, "Token transfer failed");
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // unshieldBundled — private → private notes + private → public payouts
  //                   in one proof (up to 3 internal outputs + 3 exits)
  // ──────────────────────────────────────────────────────────────────────

  function unshieldBundled(
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes[] calldata _payload
  ) public {
    require(isKnownRoot(uint256(_publicInputs[0])), "Invalid Root!");

    bool isValidProof = IVerifier(transferExternalVerifier).verify(
      _proof,
      _publicInputs
    );
    require(isValidProof, "Invalid unshieldBundled proof");

    for (uint256 i = 1; i <= NOTES_INPUT_LENGTH; i++) {
      if (_publicInputs[i] != bytes32(0)) {
        require(
          nullifierUsed[_publicInputs[i]] == false,
          "Nullifier already spent"
        );
        nullifierUsed[_publicInputs[i]] = true;
        emit NullifierUsed(_publicInputs[i]);
      }
    }

    for (
      uint256 i = NOTES_INPUT_LENGTH + 1;
      i < NOTES_INPUT_LENGTH + 1 + NOTES_INPUT_LENGTH;
      i++
    ) {
      if (_publicInputs[i] != bytes32(0)) {
        _insert(uint256(_publicInputs[i]));
      }
    }

    uint256 exitAssetStartIndex = 7;
    uint256 exitAmountStartIndex = exitAssetStartIndex + NOTES_INPUT_LENGTH;
    uint256 exitAddressStartIndex = exitAmountStartIndex + NOTES_INPUT_LENGTH;

    for (uint256 i = 0; i < NOTES_INPUT_LENGTH; i++) {
      uint256 assetIndex = exitAssetStartIndex + i;
      uint256 amountIndex = exitAmountStartIndex + i;
      uint256 addressIndex = exitAddressStartIndex + i;

      address exitAsset = address(uint160(uint256(_publicInputs[assetIndex])));
      uint256 exitAmount = uint256(_publicInputs[amountIndex]);
      address exitAddress = address(
        uint160(uint256(_publicInputs[addressIndex]))
      );

      if (exitAmount > 0 && exitAddress != address(0)) {
        if (exitAsset == ETH_ADDRESS) {
          require(
            address(this).balance >= exitAmount,
            "Insufficient ETH balance"
          );
          (bool success, ) = exitAddress.call{value: exitAmount}("");
          require(success, "ETH transfer failed");
        } else {
          bool success = IERC20(exitAsset).transfer(exitAddress, exitAmount);
          require(success, "Token transfer failed");
        }
      }
    }

    for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
      if (_payload[i].length != 0) {
        emit NotePayload(_payload[i]);
      }
    }
  }
}

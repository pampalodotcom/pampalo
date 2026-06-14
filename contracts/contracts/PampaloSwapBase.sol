// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Pampalo} from "./Pampalo.sol";
import {IVerifier} from "./verifiers/DepositVerifier.sol";

/// @title  PampaloSwapBase
/// @notice Venue-agnostic private-swap shell (ADR 0020). A private swap
///         spends private note(s) of asset A and mints a fixed-output
///         private note of asset B, executing the trade against public
///         Uniswap liquidity in one atomic transaction.
///
///         Privacy is ownership-private, amount-public: the AMM leg is
///         observable, but the spent notes' lineage is broken by their
///         nullifiers and the output note's owner is hidden.
///
///         The realized AMM output doesn't exist at proof time, so the
///         output note is minted at a fixed target `T` committed
///         in-circuit. The contract enforces `realized >= T` and
///         forfeits the surplus `realized - T` into pooled reserves —
///         `T` doubles as the slippage / sandwich floor (there is no
///         separate `minOut`). See ADR 0020.
/// @dev    Abstract: the note machinery lives here; the swap-execution
///         leg (`_executeSwap`) is supplied by a venue subclass
///         (PampaloSwapV4 / PampaloSwapV3). Deploy a subclass *instead
///         of* Pampalo — it is a superset (ADR 0017 clean-break).
abstract contract PampaloSwapBase is Pampalo {
  // Verifier for the `swap` circuit. Immutable, bytecode-bound like the
  // four base verifiers.
  address public immutable swapVerifier;

  // ──────────────────────────────────────────────────────────────────────
  // Public-input index layout — MUST match circuits/swap/src/main.nr
  // ──────────────────────────────────────────────────────────────────────
  //
  //   | idx  | field            |
  //   |------|------------------|
  //   | 0    | root             |
  //   | 1-3  | nullifiers[3]    |
  //   | 4-6  | output_hashes[3] | [4]=B@T, [5]=A change, [6]=0
  //   | 7    | input_asset      |
  //   | 8    | input_amount     |
  //   | 9    | output_asset     |
  //   | 10   | target_output T  |
  uint256 internal constant SWAP_ROOT_INDEX = 0;
  uint256 internal constant SWAP_NULLIFIER_START = 1;
  uint256 internal constant SWAP_OUTPUT_START = 4;
  uint256 internal constant SWAP_INPUT_ASSET_INDEX = 7;
  uint256 internal constant SWAP_INPUT_AMOUNT_INDEX = 8;
  uint256 internal constant SWAP_OUTPUT_ASSET_INDEX = 9;
  uint256 internal constant SWAP_TARGET_OUTPUT_INDEX = 10;

  event PrivateSwapExecuted(
    address indexed inputAsset,
    address indexed outputAsset,
    uint256 inputAmount,
    uint256 targetOutput,
    uint256 realizedOutput
  );

  constructor(
    address _depositVerifier,
    address _transferVerifier,
    address _withdrawVerifier,
    address _transferExternalVerifier,
    address _swapVerifier
  )
    Pampalo(
      _depositVerifier,
      _transferVerifier,
      _withdrawVerifier,
      _transferExternalVerifier
    )
  {
    swapVerifier = _swapVerifier;
  }

  /// @notice Spend asset-A note(s), trade `input_amount` against public
  ///         liquidity, and mint a fixed-output asset-B note at `T`
  ///         (plus an optional same-asset change note).
  /// @param _proof        The `swap` circuit proof.
  /// @param _publicInputs Layout above. `input_asset` / `output_asset` /
  ///                      `target_output` are bound in-circuit and
  ///                      re-bound to `_route` by the adapter.
  /// @param _route        Opaque venue route. v4: `abi.encode(Hop[])`;
  ///                      v3: a packed `tokenIn||fee||tokenOut[…]` path.
  /// @param _payload      Up to 3 encrypted note blobs, re-emitted as
  ///                      `NotePayload` for the recipients to trial-decrypt.
  function privateSwap(
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes calldata _route,
    bytes[] calldata _payload
  ) external {
    require(
      isKnownRoot(uint256(_publicInputs[SWAP_ROOT_INDEX])),
      "Invalid Root!"
    );

    bool isValidProof = IVerifier(swapVerifier).verify(_proof, _publicInputs);
    require(isValidProof, "Invalid swap proof");

    address inputAsset = address(
      uint160(uint256(_publicInputs[SWAP_INPUT_ASSET_INDEX]))
    );
    uint256 inputAmount = uint256(_publicInputs[SWAP_INPUT_AMOUNT_INDEX]);
    address outputAsset = address(
      uint160(uint256(_publicInputs[SWAP_OUTPUT_ASSET_INDEX]))
    );
    uint256 targetOutput = uint256(_publicInputs[SWAP_TARGET_OUTPUT_INDEX]);

    // Nullify the spent asset-A input notes [1..3]. Copied verbatim from
    // Pampalo.unshieldBundled's nullify loop. Done before the external
    // swap so a reverting venue can't leave a half-applied state.
    for (
      uint256 i = SWAP_NULLIFIER_START;
      i < SWAP_NULLIFIER_START + NOTES_INPUT_LENGTH;
      i++
    ) {
      if (_publicInputs[i] != bytes32(0)) {
        require(
          nullifierUsed[_publicInputs[i]] == false,
          "Nullifier already spent"
        );
        nullifierUsed[_publicInputs[i]] = true;
        emit NullifierUsed(_publicInputs[i]);
      }
    }

    // Trade against public liquidity (venue-specific). The adapter MUST
    // bind the route's input/output currencies to inputAsset/outputAsset
    // and enforce the `targetOutput` floor — an untrusted calldata route
    // is only safe because of those bindings.
    uint256 realized = _executeSwap(
      inputAsset,
      inputAmount,
      outputAsset,
      targetOutput,
      _route
    );

    // Belt-and-suspenders floor: the minted B note's amount is exactly
    // `targetOutput`, so the contract must hold at least that much of
    // asset B. Surplus (realized - targetOutput) is forfeited into
    // pooled reserves, unowned by any note (ADR 0020).
    require(realized >= targetOutput, "realized < target output");

    // Insert the output commitments [4..6]: [4]=B@T, [5]=change (or 0),
    // [6]=0. Copied verbatim from Pampalo.unshieldBundled's insert loop.
    for (
      uint256 i = SWAP_OUTPUT_START;
      i < SWAP_OUTPUT_START + NOTES_INPUT_LENGTH;
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

    emit PrivateSwapExecuted(
      inputAsset,
      outputAsset,
      inputAmount,
      targetOutput,
      realized
    );
  }

  /// @dev Venue-specific exact-input swap of the contract's pooled
  ///      `inputAsset` for `outputAsset`, routed by the opaque `route`.
  ///      MUST: (1) bind the route's first input currency to
  ///      `inputAsset`, (2) bind the route's last output currency to
  ///      `outputAsset`, and (3) enforce `minOut` as the on-venue floor.
  ///      Returns the realized output amount received by this contract.
  function _executeSwap(
    address inputAsset,
    uint256 inputAmount,
    address outputAsset,
    uint256 minOut,
    bytes calldata route
  ) internal virtual returns (uint256 realized);
}

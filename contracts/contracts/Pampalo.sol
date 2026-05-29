// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

import "./PoseidonMerkleTree.sol";
import {IVerifier} from "./verifiers/DepositVerifier.sol";
import {IPriceOracle} from "./oracles/IPriceOracle.sol";
import {DateMath} from "./libraries/DateMath.sol";

//                                                ☼
//                       .  .  .             .  .  .
//                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//                          ~ pampalo, on EVM ~
//                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//
/// @title  Pampalo
/// @notice ZK private-money protocol with on-chain compliance guards.
///         Public ERC-20 (or native ETH) enters the contract via
///         `shield` / `shieldNative` — but rather than landing in the
///         merkle tree immediately, the shielded asset is escrowed and
///         a 1-hour wait begins. During the wait a vigilant-citizen
///         role may `contestShield` to refund the shielder. After the
///         wait the leaf is inserted by `executeShield` (anyone may
///         call), or earlier via `executeShieldImmediate` for the
///         booth-operator bypass. Holders spend notes privately via
///         `transfer`, or back into the public layer via `unshield` /
///         `unshieldBundled`. Per-address monthly USD caps gate the
///         crossover paths; supported-asset registry + Chainlink-style
///         oracles convert (asset, amount) → USD cents.
///
/// @dev    See ADR 0006 (cap charge-at-queue with refund on cancel /
///         contest) and ADR 0007 (no SHIELD_ROLE; contest mechanism
///         replaces it).
contract Pampalo is PoseidonMerkleTree, AccessControlEnumerable {
  // ──────────────────────────────────────────────────────────────────────
  // Verifier addresses + constants (upstream-named — bytecode-bound)
  // ──────────────────────────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────────────────────────
  // Roles
  // ──────────────────────────────────────────────────────────────────────

  bytes32 public constant VIGILANT_CITIZEN_ROLE =
    keccak256("VIGILANT_CITIZEN_ROLE");
  bytes32 public constant FINANCE_MANAGER_ROLE =
    keccak256("FINANCE_MANAGER_ROLE");
  bytes32 public constant BOOTH_OPERATOR_ROLE =
    keccak256("BOOTH_OPERATOR_ROLE");

  // ──────────────────────────────────────────────────────────────────────
  // Supported assets + price oracles
  // ──────────────────────────────────────────────────────────────────────

  struct AssetConfig {
    IPriceOracle oracle;
    uint8 assetDecimals;
    bool enabled;
  }
  mapping(address => AssetConfig) public supportedAssets;

  event AssetSupported(address indexed asset, address indexed oracle);
  event AssetDisabled(address indexed asset);

  // ──────────────────────────────────────────────────────────────────────
  // Shield queue
  // ──────────────────────────────────────────────────────────────────────

  struct PendingShield {
    address shielder;
    address asset;
    uint256 amount;
    uint256 leafCommitment;
    uint64 unlockTime;
    uint64 usdCentsCharged;
    bool cancelled;
  }
  mapping(uint256 => PendingShield) public pendingShields;
  uint256 public nextPendingId;

  uint64 public shieldWaitTime = 1 hours;
  uint64 public constant MIN_SHIELD_WAIT_TIME = 1 minutes;

  event ShieldQueued(
    uint256 indexed id,
    address indexed shielder,
    address indexed asset,
    uint256 amount,
    uint256 leafCommitment,
    uint64 unlockTime,
    bytes encryptedPayload
  );
  event ShieldExecuted(uint256 indexed id);
  event ShieldCancelled(uint256 indexed id, address indexed by);
  event ShieldContested(uint256 indexed id, address indexed by, string reason);

  // ──────────────────────────────────────────────────────────────────────
  // Monthly caps
  // ──────────────────────────────────────────────────────────────────────

  struct MonthlyVolume {
    uint64 monthKey;
    uint192 usdCentsUsed;
  }
  mapping(address => MonthlyVolume) public shieldUsage;
  mapping(address => MonthlyVolume) public unshieldUsage;

  uint256 public defaultMonthlyCapUsdCents = 100_00; // $100.00
  mapping(address => uint256) public addressMonthlyCapUsdCents; // 0 = use default

  event ShieldCapCharged(address indexed user, uint256 usdCents);
  event UnshieldCapCharged(address indexed user, uint256 usdCents);
  event ShieldCapRefunded(address indexed user, uint256 usdCents);

  // ──────────────────────────────────────────────────────────────────────
  // Kill switch
  // ──────────────────────────────────────────────────────────────────────

  bool public depositsHalted;
  event DepositsHalted(address indexed by);
  event DepositsResumed(address indexed by);

  modifier whenDepositsOpen() {
    require(!depositsHalted, "deposits halted");
    _;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Construction
  // ──────────────────────────────────────────────────────────────────────

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
    _grantRole(VIGILANT_CITIZEN_ROLE, msg.sender);
    _grantRole(FINANCE_MANAGER_ROLE, msg.sender);
    _grantRole(BOOTH_OPERATOR_ROLE, msg.sender);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Admin — supported assets
  // ──────────────────────────────────────────────────────────────────────

  function addSupportedAsset(
    address asset,
    IPriceOracle oracle,
    uint8 assetDecimals
  ) external onlyRole(FINANCE_MANAGER_ROLE) {
    supportedAssets[asset] = AssetConfig({
      oracle: oracle,
      assetDecimals: assetDecimals,
      enabled: true
    });
    emit AssetSupported(asset, address(oracle));
  }

  function disableSupportedAsset(address asset)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    supportedAssets[asset].enabled = false;
    emit AssetDisabled(asset);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Admin — caps
  // ──────────────────────────────────────────────────────────────────────

  function setDefaultMonthlyCap(uint256 usdCents)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    defaultMonthlyCapUsdCents = usdCents;
  }

  function setAddressMonthlyCap(address user, uint256 usdCents)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    addressMonthlyCapUsdCents[user] = usdCents;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public read — cap state for the slider
  // ──────────────────────────────────────────────────────────────────────

  /// @notice One-shot read of the per-address shield cap state. Mirrors
  ///         the math `_bumpUsage` runs at `shield` / `shieldNative` time,
  ///         so the client slider's draggable max and the on-chain
  ///         enforcement agree. Saves a round-trip vs reading the raw
  ///         mappings + recomputing the month key client-side.
  /// @param user      Address to inspect (typically `msg.sender` from the
  ///                  client's POV).
  /// @return effectiveCapUsdCents  Per-address override if set, else the
  ///                               default. May be zero — that's a valid
  ///                               "no shielding allowed" state, not a
  ///                               sentinel.
  /// @return usdCentsUsedThisMonth Zero if the stored bucket belongs to a
  ///                               prior UTC month — same behaviour as
  ///                               `_bumpUsage`'s on-the-fly reset.
  /// @return remainingUsdCents     Saturating `cap - used`. Zero if used
  ///                               has already met or exceeded cap (e.g.
  ///                               after a finance-manager cap reduction).
  function shieldBudget(address user)
    external
    view
    returns (
      uint256 effectiveCapUsdCents,
      uint256 usdCentsUsedThisMonth,
      uint256 remainingUsdCents
    )
  {
    uint256 cap = addressMonthlyCapUsdCents[user];
    if (cap == 0) cap = defaultMonthlyCapUsdCents;
    effectiveCapUsdCents = cap;

    uint64 mk = DateMath.monthKey(block.timestamp);
    MonthlyVolume storage vol = shieldUsage[user];
    usdCentsUsedThisMonth = vol.monthKey == mk
      ? uint256(vol.usdCentsUsed)
      : 0;

    remainingUsdCents = usdCentsUsedThisMonth >= cap
      ? 0
      : cap - usdCentsUsedThisMonth;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Admin — wait time + kill switch
  // ──────────────────────────────────────────────────────────────────────

  function setShieldWaitTime(uint64 newWait)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    require(newWait >= MIN_SHIELD_WAIT_TIME, "wait too short");
    shieldWaitTime = newWait;
  }

  function weAreFull() external onlyRole(FINANCE_MANAGER_ROLE) {
    depositsHalted = true;
    emit DepositsHalted(msg.sender);
  }

  function weFoundRoom() external onlyRole(FINANCE_MANAGER_ROLE) {
    depositsHalted = false;
    emit DepositsResumed(msg.sender);
  }

  // ──────────────────────────────────────────────────────────────────────
  // shield — public ERC-20 → queued private note
  // ──────────────────────────────────────────────────────────────────────

  function shield(
    address _erc20,
    uint256 _amount,
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes calldata _encryptedPayload
  ) external whenDepositsOpen returns (uint256 id) {
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

    return _queueShield(_erc20, _amount, _publicInputs[0], _encryptedPayload);
  }

  function shieldNative(
    bytes calldata _proof,
    bytes32[] calldata _publicInputs,
    bytes calldata _encryptedPayload
  ) external payable whenDepositsOpen returns (uint256 id) {
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

    return
      _queueShield(ETH_ADDRESS, msg.value, _publicInputs[0], _encryptedPayload);
  }

  function _queueShield(
    address asset,
    uint256 amount,
    bytes32 leafCommitment,
    bytes calldata encryptedPayload
  ) internal returns (uint256 id) {
    _assertSupportedAsset(asset);

    uint64 usdCents = _chargeShield(msg.sender, asset, amount);

    id = nextPendingId++;
    uint64 unlockTime = uint64(block.timestamp) + shieldWaitTime;

    pendingShields[id] = PendingShield({
      shielder: msg.sender,
      asset: asset,
      amount: amount,
      leafCommitment: uint256(leafCommitment),
      unlockTime: unlockTime,
      usdCentsCharged: usdCents,
      cancelled: false
    });

    emit ShieldQueued(
      id,
      msg.sender,
      asset,
      amount,
      uint256(leafCommitment),
      unlockTime,
      encryptedPayload
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Shield queue lifecycle
  // ──────────────────────────────────────────────────────────────────────

  function executeShield(uint256 id) external {
    PendingShield storage p = pendingShields[id];
    require(p.shielder != address(0), "unknown pending id");
    require(!p.cancelled, "cancelled");
    require(block.timestamp >= p.unlockTime, "still in wait");

    _insert(p.leafCommitment);
    emit ShieldExecuted(id);
    delete pendingShields[id];
  }

  function executeShieldImmediate(uint256 id)
    external
    onlyRole(BOOTH_OPERATOR_ROLE)
  {
    PendingShield storage p = pendingShields[id];
    require(p.shielder != address(0), "unknown pending id");
    require(!p.cancelled, "cancelled");

    _insert(p.leafCommitment);
    emit ShieldExecuted(id);
    delete pendingShields[id];
  }

  function cancelShield(uint256 id) external {
    PendingShield storage p = pendingShields[id];
    require(p.shielder == msg.sender, "not shielder");
    require(!p.cancelled, "already cancelled");
    require(block.timestamp < p.unlockTime, "already executable");

    _refundEscrow(p.shielder, p.asset, p.amount);
    _refundShieldCap(p.shielder, p.usdCentsCharged);

    p.cancelled = true;
    emit ShieldCancelled(id, msg.sender);
  }

  function contestShield(uint256 id, string calldata reason)
    external
    onlyRole(VIGILANT_CITIZEN_ROLE)
  {
    PendingShield storage p = pendingShields[id];
    require(p.shielder != address(0), "unknown pending id");
    require(!p.cancelled, "already cancelled");
    require(bytes(reason).length > 0, "reason required");

    _refundEscrow(p.shielder, p.asset, p.amount);
    _refundShieldCap(p.shielder, p.usdCentsCharged);

    p.cancelled = true;
    emit ShieldContested(id, msg.sender, reason);
  }

  function _refundEscrow(address shielder, address asset, uint256 amount)
    internal
  {
    if (asset == ETH_ADDRESS) {
      (bool success, ) = shielder.call{value: amount}("");
      require(success, "ETH refund failed");
    } else {
      bool success = IERC20(asset).transfer(shielder, amount);
      require(success, "ERC20 refund failed");
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
  // unshield — private note(s) → public ERC-20/ETH
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

    _processExitsAndCharge(
      _publicInputs,
      EXIT_ASSET_START_INDEX,
      EXIT_AMOUNT_START_INDEX,
      EXIT_ADDRESSES_START_INDEX
    );
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

    uint256 exitAssetStart = 7;
    uint256 exitAmountStart = exitAssetStart + NOTES_INPUT_LENGTH;
    uint256 exitAddressStart = exitAmountStart + NOTES_INPUT_LENGTH;

    _processExitsAndCharge(
      _publicInputs,
      exitAssetStart,
      exitAmountStart,
      exitAddressStart
    );

    for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
      if (_payload[i].length != 0) {
        emit NotePayload(_payload[i]);
      }
    }
  }

  /// @dev Shared exit-processing path for unshield + unshieldBundled.
  ///      Iterates the 3 exit slots, asserts each non-zero asset is
  ///      supported, sums the USD value across all exits, charges the
  ///      total to msg.sender's unshieldUsage, and forwards the funds.
  function _processExitsAndCharge(
    bytes32[] calldata publicInputs,
    uint256 exitAssetStart,
    uint256 exitAmountStart,
    uint256 exitAddressStart
  ) internal {
    uint256 totalUsdCents = 0;

    for (uint256 i = 0; i < NOTES_INPUT_LENGTH; i++) {
      address exitAsset = address(
        uint160(uint256(publicInputs[exitAssetStart + i]))
      );
      uint256 exitAmount = uint256(publicInputs[exitAmountStart + i]);
      address exitAddress = address(
        uint160(uint256(publicInputs[exitAddressStart + i]))
      );

      if (exitAmount == 0) continue;
      if (exitAddress == address(0)) continue;

      _assertSupportedAsset(exitAsset);
      AssetConfig storage cfg = supportedAssets[exitAsset];
      totalUsdCents += cfg.oracle.priceUsdCents(
        exitAmount,
        cfg.assetDecimals
      );

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

    if (totalUsdCents > 0) {
      _chargeUnshieldRaw(msg.sender, totalUsdCents);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internal — cap accounting
  // ──────────────────────────────────────────────────────────────────────

  function _chargeShield(address user, address asset, uint256 amount)
    internal
    returns (uint64)
  {
    AssetConfig storage cfg = supportedAssets[asset];
    uint256 usdCents = cfg.oracle.priceUsdCents(amount, cfg.assetDecimals);
    require(usdCents <= type(uint64).max, "usdCents overflow");

    _bumpUsage(shieldUsage, user, uint64(usdCents));
    emit ShieldCapCharged(user, usdCents);
    return uint64(usdCents);
  }

  function _chargeUnshieldRaw(address user, uint256 usdCents) internal {
    require(usdCents <= type(uint64).max, "usdCents overflow");
    _bumpUsage(unshieldUsage, user, uint64(usdCents));
    emit UnshieldCapCharged(user, usdCents);
  }

  function _bumpUsage(
    mapping(address => MonthlyVolume) storage usage,
    address user,
    uint64 usdCents
  ) internal {
    uint64 mk = DateMath.monthKey(block.timestamp);
    MonthlyVolume storage vol = usage[user];
    if (vol.monthKey != mk) {
      vol.monthKey = mk;
      vol.usdCentsUsed = 0;
    }

    uint256 cap = addressMonthlyCapUsdCents[user];
    if (cap == 0) cap = defaultMonthlyCapUsdCents;

    uint256 newUsed = uint256(vol.usdCentsUsed) + uint256(usdCents);
    require(newUsed <= cap, "monthly cap exceeded");
    vol.usdCentsUsed = uint192(newUsed);
  }

  function _refundShieldCap(address user, uint64 usdCents) internal {
    if (usdCents == 0) return;

    uint64 mk = DateMath.monthKey(block.timestamp);
    MonthlyVolume storage vol = shieldUsage[user];
    if (vol.monthKey != mk) {
      // The cap was charged in a prior month — that month's budget is
      // already gone in the bucket and won't be reused. Refunding it
      // into the new month would be a free top-up; skip.
      return;
    }
    if (uint256(vol.usdCentsUsed) <= uint256(usdCents)) {
      vol.usdCentsUsed = 0;
    } else {
      vol.usdCentsUsed = uint192(uint256(vol.usdCentsUsed) - uint256(usdCents));
    }
    emit ShieldCapRefunded(user, usdCents);
  }

  function _assertSupportedAsset(address asset) internal view {
    require(supportedAssets[asset].enabled, "asset not supported");
  }
}

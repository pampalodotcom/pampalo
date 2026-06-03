// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {INameWrapper} from "./INameWrapper.sol";
import {IPampaloResolver} from "./IPampaloResolver.sol";

/// @notice Minimal Chainlink AggregatorV3 surface (ETH/USD on mainnet:
///         0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419). Mirrors the read +
///         staleness pattern in oracles/ChainlinkOracle.sol so the two stay
///         conceptually in sync.
interface AggregatorV3Interface {
  function decimals() external view returns (uint8);

  function latestRoundData()
    external
    view
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    );
}

/// @title  PampaloRegistrar
/// @notice Issues Pampalo usernames — opt-in, paid `<label>.pampalo.eth` ENS
///         subnames that resolve to the buyer's Envelope key + Poseidon
///         identifier via PampaloDirectoryResolver. Lives on Ethereum L1
///         (where ENS + NameWrapper live); deployed separately from the
///         Base-side Pampalo protocol. Mints wrapped ERC-1155 subnames under
///         a NameWrapper-wrapped `pampalo.eth` for which this contract is an
///         approved operator.
///
///         Pricing is USD-denominated ($100 / term by default), converted to
///         ETH at registration time via the Chainlink ETH/USD feed —
///         overpayment is refunded. Access control mirrors Pampalo.sol: the
///         Safe holds DEFAULT_ADMIN_ROLE; FINANCE_MANAGER_ROLE tunes price +
///         the address-allowlist discount root. See ADR 0012.
contract PampaloRegistrar is AccessControlEnumerable, ReentrancyGuard {
  bytes32 public constant FINANCE_MANAGER_ROLE =
    keccak256("FINANCE_MANAGER_ROLE");

  // ── immutable wiring ────────────────────────────────────────────────────
  INameWrapper public immutable wrapper;
  bytes32 public immutable parentNode; // namehash("pampalo.eth")
  AggregatorV3Interface public immutable ethUsdFeed;
  uint8 public immutable feedDecimals;
  uint32 public immutable maxFeedAge; // staleness window, seconds

  // ── mutable config ──────────────────────────────────────────────────────
  address public resolver; // PampaloDirectoryResolver
  address public treasury;
  uint256 public priceUsdCents; // full price, USD cents ($100 = 10_000)
  uint256 public discountUsdCents; // allowlisted price, USD cents
  bytes32 public discountRoot; // merkle root of discount-eligible addresses
  uint64 public registrationDuration; // term granted per register/renew, secs

  event Registered(
    bytes32 indexed node,
    string label,
    address indexed owner,
    uint64 expiry,
    uint256 paidWei
  );
  event Renewed(
    bytes32 indexed node,
    string label,
    uint64 expiry,
    uint256 paidWei
  );
  event PricesChanged(uint256 fullCents, uint256 discountCents);
  event DiscountRootChanged(bytes32 root);
  event RegistrationDurationChanged(uint64 duration);
  event ResolverChanged(address resolver);
  event TreasuryChanged(address treasury);

  constructor(
    INameWrapper _wrapper,
    bytes32 _parentNode,
    address _ethUsdFeed,
    uint32 _maxFeedAge,
    address _resolver,
    address _treasury,
    address _safe,
    uint256 _priceUsdCents,
    uint256 _discountUsdCents,
    uint64 _registrationDuration
  ) {
    require(_treasury != address(0) && _safe != address(0), "zero addr");
    require(_registrationDuration > 0, "zero duration");
    require(_discountUsdCents <= _priceUsdCents, "discount>full");

    wrapper = _wrapper;
    parentNode = _parentNode;
    ethUsdFeed = AggregatorV3Interface(_ethUsdFeed);
    feedDecimals = AggregatorV3Interface(_ethUsdFeed).decimals();
    maxFeedAge = _maxFeedAge;
    resolver = _resolver;
    treasury = _treasury;
    priceUsdCents = _priceUsdCents;
    discountUsdCents = _discountUsdCents;
    registrationDuration = _registrationDuration;

    _grantRole(DEFAULT_ADMIN_ROLE, _safe);
    _grantRole(FINANCE_MANAGER_ROLE, _safe);
  }

  // ── pricing views ───────────────────────────────────────────────────────

  /// @notice Current ETH/USD price (feedDecimals-scaled), reverting on
  ///         non-positive or stale data — same guards as ChainlinkOracle.
  function ethUsdPrice() public view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = ethUsdFeed.latestRoundData();
    require(answer > 0, "bad price");
    require(block.timestamp <= updatedAt + maxFeedAge, "stale price");
    return uint256(answer);
  }

  /// @notice USD cents → wei. Inverse of ChainlinkOracle.priceUsdCents for an
  ///         18-decimal asset:
  ///           cents = wei * price * 100 / (1e18 * 10^feedDecimals)
  ///       => wei   = cents * 1e18 * 10^feedDecimals / (price * 100)
  function usdCentsToWei(uint256 cents) public view returns (uint256) {
    uint256 price = ethUsdPrice();
    return (cents * 1e18 * (10 ** uint256(feedDecimals))) / (price * 100);
  }

  /// @notice Live ETH quote for a full-price registration.
  function priceWei() external view returns (uint256) {
    return usdCentsToWei(priceUsdCents);
  }

  /// @notice Live ETH quote for an allowlisted registration.
  function discountWei() external view returns (uint256) {
    return usdCentsToWei(discountUsdCents);
  }

  function nodeOf(string memory label) public view returns (bytes32) {
    return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
  }

  function available(string calldata label) external view returns (bool) {
    return wrapper.ownerOf(uint256(nodeOf(label))) == address(0);
  }

  // ── registration ──────────────────────────────────────────────────────

  /// @notice Buy `<label>.pampalo.eth` for one registration term. Mints the
  ///         wrapped subname to the caller and publishes their records. Pass
  ///         a non-empty `discountProof` to claim the allowlisted price.
  function register(
    string calldata label,
    bytes calldata envelopeKey,
    bytes32 poseidonId,
    bytes32[] calldata discountProof
  ) external payable nonReentrant {
    _validateLabel(label);
    bytes32 node = nodeOf(label);
    require(wrapper.ownerOf(uint256(node)) == address(0), "taken");

    uint256 due = usdCentsToWei(_priceCents(msg.sender, discountProof));
    require(msg.value >= due, "underpaid");

    uint64 expiry = _cappedExpiry();
    wrapper.setSubnodeRecord(parentNode, label, msg.sender, resolver, 0, 0, expiry);
    IPampaloResolver(resolver).setRecordsByRegistrar(node, envelopeKey, poseidonId);

    _collect(due);
    emit Registered(node, label, msg.sender, expiry, due);
  }

  /// @notice Extend an existing username by one more term. Expiry is re-capped
  ///         to the parent's, so a renewal can never push past `pampalo.eth`.
  function renew(string calldata label, bytes32[] calldata discountProof)
    external
    payable
    nonReentrant
  {
    bytes32 node = nodeOf(label);
    require(wrapper.ownerOf(uint256(node)) != address(0), "not registered");

    uint256 due = usdCentsToWei(_priceCents(msg.sender, discountProof));
    require(msg.value >= due, "underpaid");

    uint64 expiry = _cappedExpiry();
    wrapper.setChildFuses(parentNode, keccak256(bytes(label)), 0, expiry);

    _collect(due);
    emit Renewed(node, label, expiry, due);
  }

  function _priceCents(address buyer, bytes32[] calldata proof)
    internal
    view
    returns (uint256)
  {
    return _isDiscounted(buyer, proof) ? discountUsdCents : priceUsdCents;
  }

  /// @dev Forwards exactly `due` to the treasury and refunds any surplus, so
  ///      a buyer who overpays (e.g. against a moving price) is made whole.
  function _collect(uint256 due) internal {
    (bool ok, ) = treasury.call{value: due}("");
    require(ok, "treasury xfer failed");
    if (msg.value > due) {
      (bool refunded, ) = msg.sender.call{value: msg.value - due}("");
      require(refunded, "refund failed");
    }
  }

  /// @dev now + term, capped to the parent's expiry — a subname cannot
  ///      outlive `pampalo.eth`.
  function _cappedExpiry() internal view returns (uint64) {
    (, , uint64 parentExpiry) = wrapper.getData(uint256(parentNode));
    uint64 want = uint64(block.timestamp) + registrationDuration;
    return want < parentExpiry ? want : parentExpiry;
  }

  /// @dev OZ StandardMerkleTree leaf encoding: double-hashed `abi.encode`d
  ///      address. Empty root => discounts disabled.
  function _isDiscounted(address who, bytes32[] calldata proof)
    internal
    view
    returns (bool)
  {
    if (discountRoot == bytes32(0)) return false;
    bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(who))));
    return MerkleProof.verify(proof, discountRoot, leaf);
  }

  /// @dev Coarse guard only: rejects empty/over-long labels and any dot
  ///      (no multi-level). Full ENSIP-15 normalisation is the client's job
  ///      — the contract can't reproduce it cheaply or safely on-chain.
  function _validateLabel(string calldata label) internal pure {
    bytes memory b = bytes(label);
    require(b.length >= 1 && b.length <= 255, "bad length");
    for (uint256 i = 0; i < b.length; i++) {
      require(b[i] != 0x2e, "no dot");
    }
  }

  // ── finance role ──────────────────────────────────────────────────────

  function setPrices(uint256 fullCents, uint256 discountCents)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    require(discountCents <= fullCents, "discount>full");
    priceUsdCents = fullCents;
    discountUsdCents = discountCents;
    emit PricesChanged(fullCents, discountCents);
  }

  function setDiscountRoot(bytes32 root)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    discountRoot = root;
    emit DiscountRootChanged(root);
  }

  function setRegistrationDuration(uint64 duration)
    external
    onlyRole(FINANCE_MANAGER_ROLE)
  {
    require(duration > 0, "zero duration");
    registrationDuration = duration;
    emit RegistrationDurationChanged(duration);
  }

  // ── admin role (the Safe) ─────────────────────────────────────────────

  function setResolver(address _resolver)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
  {
    resolver = _resolver;
    emit ResolverChanged(_resolver);
  }

  function setTreasury(address _treasury)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
  {
    require(_treasury != address(0), "zero addr");
    treasury = _treasury;
    emit TreasuryChanged(_treasury);
  }

  /// @notice Recover any ETH stranded on the contract (overpayment refunds
  ///         are immediate, so this should normally be zero).
  function sweep(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
    (bool ok, ) = to.call{value: address(this).balance}("");
    require(ok, "sweep failed");
  }
}

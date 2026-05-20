import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// All ciphertext + public material only. See AUTH.md §4.
export default defineSchema({
  users: defineTable({
    userIdBytes: v.bytes(), // 16 random bytes; used as WebAuthn user.id
    // Existing rows may carry a string; new rows do not write this field.
    // See docs/adr/0001-encrypted-mnemonic-and-nothing-else.md.
    displayName: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_userIdBytes", ["userIdBytes"]),

  wallets: defineTable({
    userId: v.id("users"),
    // Encryption scheme.
    //   - "prf": mnemonic encrypted with a DEK; DEK wrapped under each
    //     credential's PRF-derived KEK. Uses mnemonicCiphertext/mnemonicIv.
    //   - "passphrase": ethers' encrypted JSON keystore (scrypt + AES-CTR),
    //     used when the passkey provider doesn't expose the PRF extension
    //     (e.g. some 1Password configurations on iOS). Uses encryptedJson.
    // Optional + missing → treat as "prf" for back-compat with rows written
    // before this column existed.
    protectionScheme: v.optional(
      v.union(v.literal("prf"), v.literal("passphrase")),
    ),
    // PRF-protected wallets only.
    mnemonicCiphertext: v.optional(v.bytes()),
    mnemonicIv: v.optional(v.bytes()),
    // Passphrase-protected wallets only. JSON string per the EIP-2335
    // (ethers) keystore format; produced by `wallet.encrypt(passphrase)`.
    encryptedJson: v.optional(v.string()),
    createdAt: v.number(),
    // Set when the user successfully completes the 3-word confirmation
    // step. Absent if they skipped it ("Do it later") or haven't seen it.
    mnemonicConfirmedAt: v.optional(v.number()),
  }).index("by_userId", ["userId"]),

  credentials: defineTable({
    userId: v.id("users"),
    walletId: v.id("wallets"),
    credentialId: v.bytes(),
    publicKey: v.bytes(), // COSE-encoded
    counter: v.number(),
    transports: v.array(v.string()),
    // Per-credential PRF salt — historical column, no longer written.
    // The client uses a single deterministic global salt; see
    // docs/adr/0001-encrypted-mnemonic-and-nothing-else.md.
    prfSalt: v.optional(v.bytes()),
    // Wrapped DEK is required for new PRF wallets; v.optional only because
    // historical rows may carry a passphrase-protected credential without
    // these fields (see docs/adr/0002-prf-required-no-passphrase-fallback.md).
    wrappedDek: v.optional(v.bytes()),
    wrappedDekIv: v.optional(v.bytes()),
    // Device label — historical column, no longer written.
    label: v.optional(v.string()),
    createdAt: v.number(),
    // Historical column, no longer written.
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_credentialId", ["credentialId"])
    .index("by_userId", ["userId"]),

  pendingRegistrations: defineTable({
    userIdBytes: v.bytes(),
    challenge: v.bytes(),
    // Historical column, no longer written. New flows pass the WebAuthn
    // displayName from the client directly without round-tripping it
    // through the database.
    displayName: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_userIdBytes", ["userIdBytes"])
    .index("by_expiresAt", ["expiresAt"]),

  pendingAuthentications: defineTable({
    challenge: v.bytes(),
    expiresAt: v.number(),
  })
    .index("by_challenge", ["challenge"])
    .index("by_expiresAt", ["expiresAt"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(), // opaque random 32-byte hex
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_expiresAt", ["expiresAt"]),

  // ─── Encrypted client-side application state ────────────────────────────
  // See CLIENT_SIDE_FIRST.md. One row per user holds a single ciphertext
  // blob of the user's preferences JSON, encrypted client-side under the
  // wallet DEK. The `revision` is an opaque monotonic counter bumped on
  // every write; it powers the cross-device "upstream has changes" UI.
  //
  // Column rules follow ADR 0001 with one documented concession: `revision`
  // is a bounded behavior signal (write count, nothing about content). New
  // tables of this shape must follow the same shape — ciphertext + iv +
  // single opaque counter, nothing else.
  userPreferences: defineTable({
    userId: v.id("users"),
    ciphertext: v.bytes(), // AES-256-GCM(DEK, JSON.stringify(prefs))
    iv: v.bytes(), // 12 bytes
    revision: v.number(), // 1, 2, 3, … server-bumped on every write
  }).index("by_userId", ["userId"]),

  // ─── Public market data ─────────────────────────────────────────────────
  // Everything below is global, public information. No user data.
  // BYO-RPC design note: networks store only `alchemySubdomain` (e.g.
  // "eth-mainnet"), never a full URL. The proxy action composes the URL
  // from process.env.ALCHEMY_API_KEY. When BYO RPC lands, the client picks
  // its own URL per-chainId; the catalog stays unchanged.

  supportedNetworks: defineTable({
    chainId: v.number(),
    name: v.string(),
    alchemySubdomain: v.string(),
    nativeSymbol: v.string(),
    nativeDecimals: v.number(),
    // True when this network's native token represents "ETH" for the
    // ETH-balance UI (Ethereum, Optimism, Arbitrum, Base, …); false for
    // L1s with non-ETH gas tokens (Polygon, etc.).
    isNative: v.boolean(),
    // LayerZero endpoint id for this chain (e.g. mainnet=30101, Sepolia=
    // 40101, Arb Sepolia=40231). Optional because future networks may be
    // seeded before LZ exists for them.
    lzEndpointId: v.optional(v.number()),
    enabled: v.boolean(),
  }).index("by_chainId", ["chainId"]),

  supportedTokens: defineTable({
    networkId: v.id("supportedNetworks"),
    // Lowercased hex. Use "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as
    // the sentinel for the native token (matches 1inch / OKX convention).
    address: v.string(),
    name: v.string(), // "USD Coin", "Ethereum", …
    symbol: v.string(),
    decimals: v.number(),
    // True only for the chain-native token row (ETH on mainnet, etc.).
    // Redundant with the sentinel address but cheaper to query.
    isNative: v.optional(v.boolean()),
    // UI display precision (e.g. USDC → 2, ETH → 5). Optional; client
    // defaults sensibly when absent.
    roundTo: v.optional(v.number()),
    // Optional FK into priceFeeds.shortId. Lets the client price token
    // balances using the same feed catalog as native ETH.
    priceFeedShortId: v.optional(v.string()),
  })
    .index("by_networkId", ["networkId"])
    .index("by_networkId_and_address", ["networkId", "address"]),

  priceFeeds: defineTable({
    // Short id used everywhere downstream — fixed lowercase "base/quote".
    // e.g. "eth/usd", "usd/aud", "usd/cad", "usd/gbp".
    shortId: v.string(),
    // All fiat-pair feeds we read live on Ethereum mainnet (per design
    // decision); networkId points at that row. Keeping this as an FK
    // avoids hard-coding chainId 1 anywhere.
    networkId: v.id("supportedNetworks"),
    aggregator: v.string(), // 0x… AggregatorV3Interface address
    feedDecimals: v.number(), // usually 8
    enabled: v.boolean(),
  }).index("by_shortId", ["shortId"]),

  // One row per feed; upserted on every refresh.
  latestPrices: defineTable({
    shortId: v.string(),
    answer: v.string(), // raw int256 as decimal string
    feedDecimals: v.number(),
    feedUpdatedAt: v.number(), // on-chain roundData.updatedAt (seconds)
    fetchedAt: v.number(), // wall clock at fetch (ms)
  }).index("by_shortId", ["shortId"]),

  // Append-only history. Field names are 1–2 chars to save bytes — this
  // table grows fast and will eventually be archived to file storage.
  priceHistory: defineTable({
    s: v.string(), // shortId
    a: v.string(), // answer
    t: v.number(), // fetchedAt (ms)
  }).index("by_s_t", ["s", "t"]),

  latestGas: defineTable({
    networkId: v.id("supportedNetworks"),
    gasPriceWei: v.string(),
    baseFeeWei: v.optional(v.string()),
    priorityFeeWei: v.optional(v.string()),
    fetchedAt: v.number(),
  }).index("by_networkId", ["networkId"]),

  gasHistory: defineTable({
    n: v.id("supportedNetworks"),
    g: v.string(), // gasPriceWei
    t: v.number(),
  }).index("by_n_t", ["n", "t"]),
});

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

  // ─── Pampalo deployments (per-chain shield/transfer/unshield surface) ──
  // One row per chain on which the Pampalo contract suite is live. Overlays
  // `supportedNetworks` via FK — no duplication of chain metadata. See
  // SHIELD_FLOW.md §2.1. `shieldWaitSeconds` + `defaultMonthlyCapUsdCents`
  // are display caches; the slider's cap math always re-reads
  // `Pampalo.shieldBudget(user)` fresh from chain.
  pampaloDeployments: defineTable({
    networkId: v.id("supportedNetworks"),
    // Lowercased 0x… Pampalo contract address. Empty string is the
    // "addresses-only" placeholder marker: the row exists so the
    // Receive picker can show the network (and carry per-network flags
    // like `separateDerivationKey`), but no Pampalo contract is live
    // there yet. Shield/transfer callers must filter `pampalo !== ""`.
    pampalo: v.string(),
    poseidon2Huff: v.string(),
    verifiers: v.object({
      deposit: v.string(),
      transfer: v.string(),
      withdraw: v.string(),
      transferExternal: v.string(),
    }),
    shieldWaitSeconds: v.number(),
    defaultMonthlyCapUsdCents: v.number(),
    // Per-deployment indexer trail. Base Sepolia ≈ 5, Eth Sepolia ≈ 12.
    confirmationDepth: v.number(),
    // Per-deployment indexer cursor. Highest block we've consumed.
    lastIndexedBlock: v.number(),
    enabled: v.boolean(),
    // Per-chain isolation flag for the ECIES envelope key. When true,
    // the client derives the envelope public key from the Pampalo
    // "isolated envelope" path (m/44'/60'/0'/0/420) instead of BIP44
    // path 0. Keeps the hot-Sync envelope key on testnet (Base Sepolia,
    // where this flag is false) from being able to decrypt notes on
    // mainnet deployments after a future hot-Sync compromise. Optional
    // for schema migration — undefined treated as true (the new
    // default) by the client. See derive-addresses.ts.
    separateDerivationKey: v.optional(v.boolean()),
  }).index("by_networkId", ["networkId"]),

  // Join table mirroring on-chain `Pampalo.supportedAssets(addr)`. Rows
  // are write-once + state flip; never deleted, so the Sentry audit view
  // can show "asset was disabled at …". See SHIELD_FLOW.md §2.2.
  //
  // `tokenId` is optional because some shieldable assets (e.g. fresh
  // Base Sepolia USDC mock that respins on every redeploy) aren't yet
  // in the stable `supportedTokens` catalogue — `tokenAddress` is
  // always present and is the canonical lookup key.
  pampaloAssets: defineTable({
    deploymentId: v.id("pampaloDeployments"),
    tokenId: v.optional(v.id("supportedTokens")),
    tokenAddress: v.string(), // lowercased; canonical lookup key
    oracle: v.string(),       // lowercased ChainlinkOracle adapter address
    assetDecimals: v.number(),
    enabled: v.boolean(),
    lastSyncedAt: v.number(), // ms — last on-chain reconciliation
  })
    .index("by_deployment", ["deploymentId"])
    .index("by_deployment_and_token", ["deploymentId", "tokenAddress"])
    .index("by_token", ["tokenId"]),

  // Mirror of on-chain ShieldQueued/Executed/Cancelled/Contested events.
  // One row per (deployment, pendingId). Drives the public `/sentry` view
  // and the cross-device propagation channel for the user's own shields.
  // The `encryptedPayload` is the raw ECIES ciphertext emitted on
  // `ShieldQueued` — public on-chain anyway. See SHIELD_FLOW.md §2.3.
  shieldQueueEntries: defineTable({
    deploymentId: v.id("pampaloDeployments"),
    pendingId: v.string(),       // decimal string of uint256 — JS Number unsafe
    shielder: v.string(),        // lowercased
    asset: v.string(),           // lowercased
    amount: v.string(),          // base units, decimal string
    leafCommitment: v.string(),  // hex
    unlockTime: v.number(),      // unix seconds
    usdCentsCharged: v.number(),
    encryptedPayload: v.bytes(),
    queuedTxHash: v.string(),
    queuedAt: v.number(),        // ms — first-seen via indexer

    state: v.union(
      v.literal("queued"),
      v.literal("executed"),
      v.literal("cancelled"),
      v.literal("contested"),
    ),
    // Populated on resolution. resolvedAt anchors the 72h ack window.
    resolvedTxHash: v.optional(v.string()),
    resolvedBy: v.optional(v.string()),   // lowercased msg.sender of the resolving tx
    resolvedAt: v.optional(v.number()),   // unix seconds — tx block timestamp
    contestReason: v.optional(v.string()), // only when state == contested
  })
    .index("by_deployment_and_state", ["deploymentId", "state"])
    .index("by_shielder", ["shielder"])
    .index("by_deployment_and_pendingId", ["deploymentId", "pendingId"])
    // Global all-deployments view by state — drives the /sentry default
    // "all networks · queued" query without scan-and-filter. See
    // SHIELD_FLOW.md §10.3.
    .index("by_state", ["state"]),

  // Mirror of `PoseidonMerkleTree.LeafInserted` events. One row per
  // executed shield / transfer / unshield output, captured by the
  // shield-queue indexer (the inheriting Pampalo contract is the
  // emitter). Lets the wallet rebuild the off-chain merkle tree to
  // generate transfer / unshield proofs without scanning chain logs
  // itself. See TRANSFERS.md §9.5.
  //
  // (epoch, leafIndex) is the natural compound PK; both are indexed
  // event topics. We expose two queries: ordered-walk to populate the
  // local PoseidonMerkleTree mirror, and a by-commitment lookup to
  // resolve "what leaf index does this note's leafCommitment occupy?"
  // for clients that already track the commitment in IDB.
  //
  // `epoch` (called `treeIndex` in CONTEXT.md / IDB schemas) advances
  // whenever the on-chain tree fills (2^11 = 2048 leaves per epoch).
  // For v1 Base Sepolia traffic we expect epoch=0 indefinitely.
  pampaloLeaves: defineTable({
    deploymentId: v.id("pampaloDeployments"),
    epoch: v.number(),
    leafIndex: v.number(),
    leafCommitment: v.string(),   // 0x + 64 hex (lowercased)
    insertedTxHash: v.string(),
    insertedAt: v.number(),       // ms — first-seen via indexer
  })
    .index("by_deployment_and_position", ["deploymentId", "epoch", "leafIndex"])
    .index("by_deployment_and_commitment", ["deploymentId", "leafCommitment"])
    .index("by_deployment", ["deploymentId"]),

  // Mirror of `Pampalo.NotePayload(bytes ciphertext)` events. Every
  // output note (shield, transfer, unshield) emits one. The receiver
  // walks this table on Sync, trial-decrypting each ciphertext with
  // their envelope private key — successful decrypts identify notes
  // owned by the user (TRANSFERS.md §9.5).
  //
  // Shield emissions ARE included here even though they're also in
  // shieldQueueEntries.encryptedPayload (shieldQueueEntries.byShielder
  // is the optimization path for known-self shields). The receiver
  // path is the only one that finds cross-recipient transfer notes,
  // so duplicating the shield case is the price of one table
  // covering all NotePayload sources.
  transferNotes: defineTable({
    deploymentId: v.id("pampaloDeployments"),
    encryptedPayload: v.bytes(),  // raw ECIES blob from the event
    txHash: v.string(),
    blockNumber: v.number(),
    logIndex: v.number(),         // tx-internal ordering
    emittedAt: v.number(),        // ms — first-seen via indexer
  })
    .index("by_deployment_and_block", [
      "deploymentId",
      "blockNumber",
      "logIndex",
    ])
    .index("by_deployment_and_tx", ["deploymentId", "txHash"])
    .index("by_deployment", ["deploymentId"]),

  // Cached Uniswap pool addresses. Pool addresses are deterministic
  // (CREATE2 from factory + tokens [+ fee for v3]) and can always be
  // recomputed on-chain via factory.getPair / factory.getPool, but
  // caching avoids one RPC per quote and gives us a place to mark a
  // pool as disabled if it ever depegs / loses all liquidity.
  //
  // Token ordering is canonical: token0 < token1 (lowercased hex). The
  // `getPool` action normalizes user input before lookup so callers
  // don't need to sort.
  uniswapPools: defineTable({
    networkId: v.id("supportedNetworks"),
    version: v.union(v.literal("v2"), v.literal("v3")),
    token0: v.string(), // lowercased; token0 < token1
    token1: v.string(), // lowercased
    fee: v.optional(v.number()), // v3 only: 100/500/3000/10000
    address: v.string(), // lowercased pool address
    enabled: v.boolean(),
  })
    .index("by_pair", ["networkId", "version", "token0", "token1", "fee"])
    .index("by_networkId", ["networkId"]),
});

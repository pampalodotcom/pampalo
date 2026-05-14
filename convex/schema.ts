import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// All ciphertext + public material only. See AUTH.md §4.
export default defineSchema({
  users: defineTable({
    userIdBytes: v.bytes(), // 16 random bytes; used as WebAuthn user.id
    displayName: v.string(),
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
    // PRF-only fields; absent for credentials bound to passphrase wallets.
    prfSalt: v.optional(v.bytes()),
    wrappedDek: v.optional(v.bytes()),
    wrappedDekIv: v.optional(v.bytes()),
    label: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_credentialId", ["credentialId"])
    .index("by_userId", ["userId"]),

  pendingRegistrations: defineTable({
    userIdBytes: v.bytes(),
    challenge: v.bytes(),
    displayName: v.string(),
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
});

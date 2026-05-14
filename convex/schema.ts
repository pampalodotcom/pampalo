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
    mnemonicCiphertext: v.bytes(),
    mnemonicIv: v.bytes(),
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
    prfSalt: v.bytes(),
    wrappedDek: v.bytes(),
    wrappedDekIv: v.bytes(),
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

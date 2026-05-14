import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Internal: ceremony start (HTTP routes call these) ────────────────────

export const _startRegistration = internalMutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const userIdBytes = randomBytes(16);
    const challenge = randomBytes(32);
    await ctx.db.insert("pendingRegistrations", {
      userIdBytes: userIdBytes.buffer as ArrayBuffer,
      challenge: challenge.buffer as ArrayBuffer,
      displayName: args.displayName,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return {
      userIdBytes: userIdBytes.buffer as ArrayBuffer,
      challenge: challenge.buffer as ArrayBuffer,
    };
  },
});

export const _startAuthentication = internalMutation({
  args: {},
  handler: async (ctx) => {
    const challenge = randomBytes(32);
    await ctx.db.insert("pendingAuthentications", {
      challenge: challenge.buffer as ArrayBuffer,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return { challenge: challenge.buffer as ArrayBuffer };
  },
});

// ─── Public query: encrypted blob for an authenticated session ────────────

export const getEncryptedBlob = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await sessionByTokenOrNull(ctx, args.sessionToken);
    if (!session) return null;

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .first();
    if (!wallet) return null;

    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .take(16);

    const scheme = wallet.protectionScheme ?? "prf";
    return {
      wallet: {
        protectionScheme: scheme,
        mnemonicCiphertext: wallet.mnemonicCiphertext ?? null,
        mnemonicIv: wallet.mnemonicIv ?? null,
        encryptedJson: wallet.encryptedJson ?? null,
        mnemonicConfirmedAt: wallet.mnemonicConfirmedAt ?? null,
      },
      credentials: credentials.map((c) => ({
        credentialId: c.credentialId,
        prfSalt: c.prfSalt ?? null,
        wrappedDek: c.wrappedDek ?? null,
        wrappedDekIv: c.wrappedDekIv ?? null,
        label: c.label,
      })),
    };
  },
});

// Public mutation: marks the wallet's mnemonic as confirmed by the user.
// Idempotent — calling it twice is fine.
export const confirmMnemonic = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await sessionByTokenOrNull(ctx, args.sessionToken);
    if (!session) throw new Error("invalid session");
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .first();
    if (!wallet) throw new Error("no wallet for this session");
    if (wallet.mnemonicConfirmedAt) return { confirmedAt: wallet.mnemonicConfirmedAt };
    const confirmedAt = Date.now();
    await ctx.db.patch(wallet._id, { mnemonicConfirmedAt: confirmedAt });
    return { confirmedAt };
  },
});

// ─── Internal helpers ──────────────────────────────────────────────────────

export const _findPendingRegistration = internalQuery({
  args: { userIdBytes: v.bytes() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pendingRegistrations")
      .withIndex("by_userIdBytes", (q) =>
        q.eq("userIdBytes", args.userIdBytes),
      )
      .first();
    if (!row) return null;
    if (row.expiresAt < Date.now()) return null;
    return row;
  },
});

export const _findPendingAuthenticationByChallenge = internalQuery({
  args: { challenge: v.bytes() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pendingAuthentications")
      .withIndex("by_challenge", (q) => q.eq("challenge", args.challenge))
      .first();
    if (!row) return null;
    if (row.expiresAt < Date.now()) return null;
    return row;
  },
});

export const _findCredentialByCredentialId = internalQuery({
  args: { credentialId: v.bytes() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("credentials")
      .withIndex("by_credentialId", (q) => q.eq("credentialId", args.credentialId))
      .first();
  },
});

export const _completeRegistration = internalMutation({
  args: {
    pendingId: v.id("pendingRegistrations"),
    userIdBytes: v.bytes(),
    displayName: v.string(),
    // Discriminated union: PRF-protected wallets carry the per-credential
    // wrapped DEK + the wallet's mnemonic ciphertext + IV; passphrase
    // wallets carry only the ethers encrypted-JSON keystore string and
    // omit the PRF fields on both the wallet and the credential.
    payload: v.union(
      v.object({
        scheme: v.literal("prf"),
        credential: v.object({
          credentialId: v.bytes(),
          publicKey: v.bytes(),
          counter: v.number(),
          transports: v.array(v.string()),
          prfSalt: v.bytes(),
          wrappedDek: v.bytes(),
          wrappedDekIv: v.bytes(),
          label: v.string(),
        }),
        wallet: v.object({
          mnemonicCiphertext: v.bytes(),
          mnemonicIv: v.bytes(),
        }),
      }),
      v.object({
        scheme: v.literal("passphrase"),
        credential: v.object({
          credentialId: v.bytes(),
          publicKey: v.bytes(),
          counter: v.number(),
          transports: v.array(v.string()),
          label: v.string(),
        }),
        wallet: v.object({
          encryptedJson: v.string(),
        }),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Idempotency: if the credentialId already exists, this is a retry.
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.payload.credential.credentialId),
      )
      .first();
    if (existing) {
      // Surface the existing user's session rather than duplicate-insert.
      const token = await issueSession(ctx, existing.userId);
      return {
        sessionToken: token.token,
        expiresAt: token.expiresAt,
      };
    }

    const now = Date.now();
    const userId: Id<"users"> = await ctx.db.insert("users", {
      userIdBytes: args.userIdBytes,
      displayName: args.displayName,
      createdAt: now,
    });

    let walletId: Id<"wallets">;
    if (args.payload.scheme === "prf") {
      walletId = await ctx.db.insert("wallets", {
        userId,
        protectionScheme: "prf",
        mnemonicCiphertext: args.payload.wallet.mnemonicCiphertext,
        mnemonicIv: args.payload.wallet.mnemonicIv,
        createdAt: now,
      });
      await ctx.db.insert("credentials", {
        userId,
        walletId,
        credentialId: args.payload.credential.credentialId,
        publicKey: args.payload.credential.publicKey,
        counter: args.payload.credential.counter,
        transports: args.payload.credential.transports,
        prfSalt: args.payload.credential.prfSalt,
        wrappedDek: args.payload.credential.wrappedDek,
        wrappedDekIv: args.payload.credential.wrappedDekIv,
        label: args.payload.credential.label,
        createdAt: now,
      });
    } else {
      walletId = await ctx.db.insert("wallets", {
        userId,
        protectionScheme: "passphrase",
        encryptedJson: args.payload.wallet.encryptedJson,
        createdAt: now,
      });
      await ctx.db.insert("credentials", {
        userId,
        walletId,
        credentialId: args.payload.credential.credentialId,
        publicKey: args.payload.credential.publicKey,
        counter: args.payload.credential.counter,
        transports: args.payload.credential.transports,
        label: args.payload.credential.label,
        createdAt: now,
      });
    }
    await ctx.db.delete(args.pendingId);

    const token = await issueSession(ctx, userId);
    return {
      sessionToken: token.token,
      expiresAt: token.expiresAt,
    };
  },
});

export const _completeAuthentication = internalMutation({
  args: {
    credentialDocId: v.id("credentials"),
    pendingAuthDocId: v.id("pendingAuthentications"),
    newCounter: v.number(),
  },
  handler: async (ctx, args) => {
    const cred = await ctx.db.get(args.credentialDocId);
    if (!cred) throw new Error("credential vanished");
    await ctx.db.patch(args.credentialDocId, {
      counter: args.newCounter,
      lastUsedAt: Date.now(),
    });
    await ctx.db.delete(args.pendingAuthDocId);
    const token = await issueSession(ctx, cred.userId);
    return { sessionToken: token.token, expiresAt: token.expiresAt };
  },
});

export const _deleteSessionByToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const _getSessionByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    return await sessionByTokenOrNull(ctx, args.token);
  },
});

export const _bootstrapBlob = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await sessionByTokenOrNull(ctx, args.token);
    if (!session) return null;
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .first();
    if (!wallet) return null;
    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .take(16);
    const scheme = wallet.protectionScheme ?? "prf";
    return {
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      wallet: {
        protectionScheme: scheme,
        // PRF wallets carry the DEK-encrypted mnemonic; passphrase wallets
        // carry the ethers encrypted-JSON keystore string. Both are sent
        // so the client can decide which path to take based on the scheme.
        mnemonicCiphertext: wallet.mnemonicCiphertext ?? null,
        mnemonicIv: wallet.mnemonicIv ?? null,
        encryptedJson: wallet.encryptedJson ?? null,
        mnemonicConfirmedAt: wallet.mnemonicConfirmedAt ?? null,
      },
      credentials: credentials.map((c) => ({
        credentialId: c.credentialId,
        prfSalt: c.prfSalt ?? null,
        wrappedDek: c.wrappedDek ?? null,
        wrappedDekIv: c.wrappedDekIv ?? null,
        label: c.label,
      })),
    };
  },
});

// ─── Cleanup cron ──────────────────────────────────────────────────────────

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const BATCH = 64;

    const pendingRegs = await ctx.db
      .query("pendingRegistrations")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH);
    for (const row of pendingRegs) await ctx.db.delete(row._id);

    const pendingAuths = await ctx.db
      .query("pendingAuthentications")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH);
    for (const row of pendingAuths) await ctx.db.delete(row._id);

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH);
    for (const row of sessions) await ctx.db.delete(row._id);

    return null;
  },
});

// ─── Internals ─────────────────────────────────────────────────────────────

async function issueSession(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await ctx.db.insert("sessions", { userId, token, expiresAt });
  return { token, expiresAt };
}

async function sessionByTokenOrNull(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"sessions"> | null> {
  if (!token) return null;
  const row = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();
  if (!row) return null;
  if (row.expiresAt < Date.now()) return null;
  return row;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function randomHex(n: number): string {
  const b = randomBytes(n);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

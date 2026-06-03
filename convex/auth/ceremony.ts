import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Internal: ceremony start (HTTP routes call these) ────────────────────

export const _startRegistration = internalMutation({
  args: {},
  handler: async (ctx) => {
    const userIdBytes = randomBytes(16);
    const challenge = randomBytes(32);
    await ctx.db.insert("pendingRegistrations", {
      userIdBytes: userIdBytes.buffer as ArrayBuffer,
      challenge: challenge.buffer as ArrayBuffer,
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
    if (!wallet || !wallet.mnemonicCiphertext || !wallet.mnemonicIv) {
      return null;
    }

    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .take(16);

    return {
      wallet: {
        mnemonicCiphertext: wallet.mnemonicCiphertext,
        mnemonicIv: wallet.mnemonicIv,
      },
      credentials: credentials
        .filter((c) => c.wrappedDek && c.wrappedDekIv)
        .map((c) => ({
          credentialId: c.credentialId,
          wrappedDek: c.wrappedDek as ArrayBuffer,
          wrappedDekIv: c.wrappedDekIv as ArrayBuffer,
          transports: c.transports,
        })),
    };
  },
});

// ─── Internal helpers ──────────────────────────────────────────────────────

export const _findPendingRegistration = internalQuery({
  args: { userIdBytes: v.bytes() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pendingRegistrations")
      .withIndex("by_userIdBytes", (q) => q.eq("userIdBytes", args.userIdBytes))
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
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.credentialId),
      )
      .first();
  },
});

export const _completeRegistration = internalMutation({
  args: {
    pendingId: v.id("pendingRegistrations"),
    userIdBytes: v.bytes(),
    credential: v.object({
      credentialId: v.bytes(),
      publicKey: v.bytes(),
      counter: v.number(),
      transports: v.array(v.string()),
      wrappedDek: v.bytes(),
      wrappedDekIv: v.bytes(),
    }),
    wallet: v.object({
      mnemonicCiphertext: v.bytes(),
      mnemonicIv: v.bytes(),
    }),
  },
  handler: async (ctx, args) => {
    // Idempotency: if the credentialId already exists, this is a retry.
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.credential.credentialId),
      )
      .first();
    if (existing) {
      const token = await issueSession(ctx, existing.userId);
      return {
        sessionToken: token.token,
        expiresAt: token.expiresAt,
      };
    }

    const now = Date.now();
    const userId: Id<"users"> = await ctx.db.insert("users", {
      userIdBytes: args.userIdBytes,
      createdAt: now,
    });

    const walletId: Id<"wallets"> = await ctx.db.insert("wallets", {
      userId,
      mnemonicCiphertext: args.wallet.mnemonicCiphertext,
      mnemonicIv: args.wallet.mnemonicIv,
      createdAt: now,
    });
    await ctx.db.insert("credentials", {
      userId,
      walletId,
      credentialId: args.credential.credentialId,
      publicKey: args.credential.publicKey,
      counter: args.credential.counter,
      transports: args.credential.transports,
      wrappedDek: args.credential.wrappedDek,
      wrappedDekIv: args.credential.wrappedDekIv,
      createdAt: now,
    });
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
    await ctx.db.patch(args.credentialDocId, { counter: args.newCounter });
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
    if (!wallet || !wallet.mnemonicCiphertext || !wallet.mnemonicIv) {
      return null;
    }
    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .take(16);
    return {
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      wallet: {
        mnemonicCiphertext: wallet.mnemonicCiphertext,
        mnemonicIv: wallet.mnemonicIv,
      },
      credentials: credentials
        .filter((c) => c.wrappedDek && c.wrappedDekIv)
        .map((c) => ({
          credentialId: c.credentialId,
          wrappedDek: c.wrappedDek as ArrayBuffer,
          wrappedDekIv: c.wrappedDekIv as ArrayBuffer,
          transports: c.transports,
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

export async function sessionByTokenOrNull(
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

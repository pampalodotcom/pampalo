// Encrypted user preferences — see CLIENT_SIDE_FIRST.md.
//
// One row per user. The server stores only ciphertext + IV + an opaque
// monotonic revision counter. The cleartext JSON shape, the schema of
// any preference field, and the encryption key all live client-side.
//
// The mutation enforces a 64KB cap on the ciphertext as a defence-in-depth
// guard against runaway growth (client enforces the same cap, but a hostile
// client shouldn't be able to bypass it).

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { sessionByTokenOrNull } from "../auth/ceremony";

// Same cap as documented in CLIENT_SIDE_FIRST.md. Generous enough that
// realistic prefs never approach it; tight enough that a programming error
// (someone stuffing an image, log, or tx blob) gets surfaced immediately.
const CIPHERTEXT_CAP_BYTES = 64 * 1024;

export const getEncryptedPreferences = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await sessionByTokenOrNull(ctx, args.sessionToken);
    if (!session) return null;

    const row = await ctx.db
      .query("userPreferences")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .unique();
    if (!row) return null;

    return {
      ciphertext: row.ciphertext,
      iv: row.iv,
      revision: row.revision,
    };
  },
});

// Cheap "did anything change" check — the BalanceCard sync indicator
// subscribes to this via Convex's reactive query and lights up when the
// returned revision exceeds the client's last-seen value. Returning just
// the integer avoids re-shipping the ciphertext on every revision bump.
export const getPreferencesRevision = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await sessionByTokenOrNull(ctx, args.sessionToken);
    if (!session) return null;

    const row = await ctx.db
      .query("userPreferences")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .unique();
    return row ? row.revision : null;
  },
});

export const writeEncryptedPreferences = mutation({
  args: {
    sessionToken: v.string(),
    ciphertext: v.bytes(),
    iv: v.bytes(),
  },
  handler: async (ctx, args) => {
    const session = await sessionByTokenOrNull(ctx, args.sessionToken);
    if (!session) {
      throw new Error("Unauthenticated");
    }

    if (args.ciphertext.byteLength > CIPHERTEXT_CAP_BYTES) {
      throw new Error(
        `Preferences ciphertext exceeds ${CIPHERTEXT_CAP_BYTES}-byte cap`,
      );
    }
    // IV is fixed at 12 bytes (AES-GCM). Reject anything else as a
    // malformed client write rather than silently storing it.
    if (args.iv.byteLength !== 12) {
      throw new Error("Preferences IV must be 12 bytes");
    }

    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .unique();

    if (existing) {
      const nextRevision = existing.revision + 1;
      await ctx.db.patch(existing._id, {
        ciphertext: args.ciphertext,
        iv: args.iv,
        revision: nextRevision,
      });
      return { revision: nextRevision };
    }

    await ctx.db.insert("userPreferences", {
      userId: session.userId,
      ciphertext: args.ciphertext,
      iv: args.iv,
      revision: 1,
    });
    return { revision: 1 };
  },
});

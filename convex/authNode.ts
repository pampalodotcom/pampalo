"use node";

import { Buffer } from "node:buffer";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// All inputs from the client are base64url-encoded strings as produced by
// @simplewebauthn/browser; @simplewebauthn/server consumes these directly.

export const verifyAndCompleteRegistration = internalAction({
  args: {
    userIdBytes: v.bytes(),
    expectedRPID: v.string(),
    expectedOrigin: v.string(),
    attestation: v.any(), // RegistrationResponseJSON shape from the browser
    walletPayload: v.object({
      mnemonicCiphertext: v.bytes(),
      mnemonicIv: v.bytes(),
      wrappedDek: v.bytes(),
      wrappedDekIv: v.bytes(),
    }),
  },
  handler: async (ctx, args) => {
    const pending = await ctx.runQuery(internal.auth._findPendingRegistration, {
      userIdBytes: args.userIdBytes,
    });
    if (!pending) throw new Error("registration ceremony expired or unknown");

    const expectedChallenge = bufferToBase64Url(pending.challenge);

    const verification = await verifyRegistrationResponse({
      response: args.attestation,
      expectedChallenge,
      expectedOrigin: args.expectedOrigin,
      expectedRPID: args.expectedRPID,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      throw new Error("attestation verification failed");
    }

    const reg = verification.registrationInfo;
    const credentialId = reg.credential.id; // base64url string in v13
    const credentialPublicKey = reg.credential.publicKey; // Uint8Array
    const counter = reg.credential.counter;
    const transports = reg.credential.transports ?? [];

    const completion: { sessionToken: string; expiresAt: number } =
      await ctx.runMutation(internal.auth._completeRegistration, {
        pendingId: pending._id,
        userIdBytes: args.userIdBytes,
        credential: {
          credentialId: base64UrlToBuffer(credentialId),
          publicKey: bufferFromUint8(credentialPublicKey),
          counter,
          transports,
          wrappedDek: args.walletPayload.wrappedDek,
          wrappedDekIv: args.walletPayload.wrappedDekIv,
        },
        wallet: {
          mnemonicCiphertext: args.walletPayload.mnemonicCiphertext,
          mnemonicIv: args.walletPayload.mnemonicIv,
        },
      });

    return completion;
  },
});

export const verifyAndCompleteAuthentication = internalAction({
  args: {
    expectedRPID: v.string(),
    expectedOrigin: v.string(),
    assertion: v.any(), // AuthenticationResponseJSON shape from the browser
  },
  handler: async (ctx, args) => {
    // Pull credentialId out of the assertion — it identifies the user.
    const rawIdB64Url: string = args.assertion?.id;
    if (!rawIdB64Url || typeof rawIdB64Url !== "string") {
      throw new Error("assertion missing credential id");
    }
    const credentialIdBytes = base64UrlToBuffer(rawIdB64Url);
    const credential = await ctx.runQuery(
      internal.auth._findCredentialByCredentialId,
      { credentialId: credentialIdBytes },
    );
    if (!credential) throw new Error("unknown credential");

    // Reconstruct the challenge from the assertion's clientDataJSON.
    const challengeBytes = extractChallengeFromAssertion(args.assertion);
    const pending = await ctx.runQuery(
      internal.auth._findPendingAuthenticationByChallenge,
      { challenge: challengeBytes },
    );
    if (!pending) throw new Error("auth ceremony expired or unknown");

    const expectedChallenge = bufferToBase64Url(challengeBytes);

    const verification = await verifyAuthenticationResponse({
      response: args.assertion,
      expectedChallenge,
      expectedOrigin: args.expectedOrigin,
      expectedRPID: args.expectedRPID,
      requireUserVerification: true,
      credential: {
        id: rawIdB64Url,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports as Array<
          "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb"
        >,
      },
    });

    if (!verification.verified) {
      throw new Error("assertion verification failed");
    }

    const completion: { sessionToken: string; expiresAt: number } =
      await ctx.runMutation(internal.auth._completeAuthentication, {
        credentialDocId: credential._id,
        pendingAuthDocId: pending._id,
        newCounter: verification.authenticationInfo.newCounter,
      });

    return completion;
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractChallengeFromAssertion(assertion: {
  response: { clientDataJSON: string };
}): ArrayBuffer {
  const clientDataB64Url = assertion.response.clientDataJSON;
  const clientDataJson = Buffer.from(
    base64UrlToBuffer(clientDataB64Url),
  ).toString("utf-8");
  const parsed = JSON.parse(clientDataJson) as { challenge: string };
  return base64UrlToBuffer(parsed.challenge);
}

function base64UrlToBuffer(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function bufferToBase64Url(buf: ArrayBuffer): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function bufferFromUint8(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

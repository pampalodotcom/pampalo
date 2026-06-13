/// <reference types="vite/client" />
import { HDNodeWallet, SigningKey, Wallet } from "ethers";
import { describe, expect, test } from "vitest";
import { NoteDecryption } from "@pampalo/shared/classes/Note";
import {
  ENVELOPE_ISOLATED_SLOT,
  deriveEnvelopeIsolatedPrivateKey,
} from "./derive-addresses";

// ---------------------------------------------------------------------------
// Repro for the "private transfer $1 from /share never arrives" bug on Base
// mainnet. The booth sender ECIES-encrypts each output note's four-tuple to
// the recipient's envelope public key (see transfer-prep.ts → NoteEncryption
// .encryptNoteData). If the sender encrypted to the WRONG envelope key (e.g.
// path-0 instead of the isolated slot-420 key, or vice versa), the recipient
// can never decrypt and the note never shows up in their wallet.
//
// This test takes the two on-chain payloads the user observed, derives BOTH
// envelope private keys from EXPORTED_MNEMONIC, and reports which key (if
// any) can decrypt them — and whether the decrypted `owner` matches the
// recipient's poseidon identifier.
//
// Run with:
//   EXPORTED_MNEMONIC="word word ..." pnpm test envelope-decrypt-debug
// ---------------------------------------------------------------------------

// The recipient material the user shared (their /share QR params):
const RECIPIENT_ENVELOPE_PUBKEY =
  "0x048b32285504a3ccb3f3539a4441af5c720e14714665d83a586cf39ecfa082123ccdeb2cba2b71b5fb235777be216bd69d1f6536f34fad4fa39416428e8546422d";
const RECIPIENT_POSEIDON =
  "0x26d216d0c890ec9719597adabde7d12e332f3183c151445ea7586cd0f432e07d";

// The two ECIES payloads that were broadcast (transfer outputs):
const PAYLOADS: Record<string, string> = {
  "payload[0]":
    "0x047ca289881455b2c714dc342ccf9a68b693647c027b6aa36784a8109f6322d9b641546d783eb5e6163d561b4387f61d596c98c8c8e4c871486433be6887cefe7daeff1336849c834f967b62da4ffdc20251bc201963c18ddc4ec3fd25606e73e56f663cbc140c259f4fa917c7517c6d549b2706e2c49d951e84998a5dec9991160da728ad2531a70f060ea5cbe41ba62473973551daf66055f36c25030230ec7e1f43f38acbd3ddb2fd1e4a247b4e75a0d7ff1d8dc010ceaae785e0f74ea5aa59f296653592b2fe37f046b22f8b4c0a3cc0942ee9ddeb22bc9e62da5764bd887a",
  "payload[1]":
    "0x043137f4d68064e607eb06e5340a767a12eec0aa9d01df75466505088c622490860af48e06f8a81a622fa523f3e1506dac003a98c3354dd50f9338b3d4677318b618cfc80ec76a131b6fe3efaf7e1a54b292b28d63420b638001350d274fc887d716f9457b6ec0c0a75d5c2bfd624637091d7e2ff94e6d76b32584526e829517e56823fd6e9b28bfd914eccbb18f4f06b43e1c34df4d3ec01f526399c2fb4e15cae23d76560c7ccae27bdf2ffeca4ac7a8d744234c6dc469fd1e424d9990c320caa0ba1e1dd4c2da9d4c21f7175fb35153244e6d9e99123079229f392a2d26a189",
};

const MNEMONIC = process.env.EXPORTED_MNEMONIC;

// `describe.runIf` skips the TESTS when the mnemonic is absent, but the
// callback body still runs at collection time — so derive lazily, inside
// the test bodies, to avoid `Wallet.fromPhrase(undefined)` throwing during
// collection on machines without EXPORTED_MNEMONIC set.
function envelopeKeys(mnemonic: string): { label: string; privKey: string }[] {
  return [
    {
      label: "path-0 (m/44'/60'/0'/0/0, shared)",
      privKey: Wallet.fromPhrase(mnemonic).privateKey,
    },
    {
      label: `isolated (m/44'/60'/0'/0/${ENVELOPE_ISOLATED_SLOT})`,
      privKey: deriveEnvelopeIsolatedPrivateKey(mnemonic),
    },
  ];
}

describe.runIf(MNEMONIC)("envelope payload decrypt (Base mainnet repro)", () => {
  const mnemonic = MNEMONIC as string;

  test("derived envelope public keys vs. the recipient's QR envelope key", () => {
    const keys = envelopeKeys(mnemonic);
    const path0PrivKey = keys[0].privKey;
    const path0Pub = new SigningKey(path0PrivKey).publicKey;
    const isoPub = new SigningKey(
      HDNodeWallet.fromPhrase(
        mnemonic,
        undefined,
        `m/44'/60'/0'/0/${ENVELOPE_ISOLATED_SLOT}`,
      ).privateKey,
    ).publicKey;

    const target = RECIPIENT_ENVELOPE_PUBKEY.toLowerCase();
    console.log("\n=== Envelope public key comparison ===");
    console.log("recipient QR envelope key:", target);
    console.log("derived path-0 envelope:  ", path0Pub.toLowerCase());
    console.log("derived isolated envelope:", isoPub.toLowerCase());
    console.log(
      "QR key matches path-0?  ",
      path0Pub.toLowerCase() === target,
    );
    console.log("QR key matches isolated?", isoPub.toLowerCase() === target);

    // At least one derived envelope key must equal the QR key, otherwise the
    // mnemonic doesn't correspond to this recipient at all.
    expect([path0Pub.toLowerCase(), isoPub.toLowerCase()]).toContain(target);
  });

  test("the recipient can decrypt their own note from the broadcast payloads", async () => {
    // A booth transfer emits one payload per output: the recipient's note
    // AND the operator's change note (encrypted to the OPERATOR's envelope).
    // So we expect exactly one of these payloads to decrypt under the
    // recipient's keys, with `owner` == the recipient's poseidon id. The
    // other payload (the change) is correctly NOT decryptable here.
    const keys = envelopeKeys(mnemonic);
    let recipientNote: Awaited<
      ReturnType<typeof NoteDecryption.decryptNoteData>
    > | null = null;

    for (const [name, payload] of Object.entries(PAYLOADS)) {
      console.log(`\n=== ${name} ===`);
      for (const { label, privKey } of keys) {
        try {
          const note = await NoteDecryption.decryptNoteData(payload, privKey);
          const ownerMatches =
            "0x" + BigInt(note.owner).toString(16).padStart(64, "0") ===
            RECIPIENT_POSEIDON.toLowerCase();
          console.log(`  [${label}] DECRYPTED:`, {
            secret: note.secret,
            owner: note.owner,
            asset_id:
              "0x" + BigInt(note.asset_id).toString(16).padStart(40, "0"),
            asset_amount: note.asset_amount,
            ownerMatchesRecipientPoseidon: ownerMatches,
          });
          if (ownerMatches) recipientNote = note;
        } catch (e) {
          console.log(
            `  [${label}] failed:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
    }

    // The on-chain ciphertext IS decryptable by this mnemonic's isolated
    // envelope key and addressed to this recipient. If this passes, the
    // booth encrypted correctly — the "never arrives" bug is downstream in
    // the recipient's sync/scan (e.g. not trying the isolated key), not in
    // the transfer's envelope encryption.
    expect(
      recipientNote,
      "No broadcast payload decrypted to a note owned by the recipient's poseidon id.",
    ).not.toBeNull();
  });
});

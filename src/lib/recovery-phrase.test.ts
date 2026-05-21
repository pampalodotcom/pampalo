/// <reference types="vite/client" />
import { Wallet } from "ethers";
import { describe, expect, test } from "vitest";
import { parseRecoveryPhrase } from "./recovery-phrase";

// A well-known BIP-39 test vector — the first valid English mnemonic
// in lexical order. Used as the canonical "happy path" input.
const ABANDON_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("parseRecoveryPhrase", () => {
  test("empty input", () => {
    expect(parseRecoveryPhrase("")).toEqual({ status: "empty" });
    expect(parseRecoveryPhrase("   \n\t  ")).toEqual({ status: "empty" });
  });

  test("partial (still typing)", () => {
    const result = parseRecoveryPhrase("abandon abandon abandon");
    expect(result).toEqual({ status: "partial", count: 3 });
  });

  test("valid 12-word phrase", () => {
    expect(parseRecoveryPhrase(ABANDON_PHRASE)).toEqual({
      status: "valid",
      mnemonic: ABANDON_PHRASE,
    });
  });

  test("accepts the .txt download format (comment header + words)", () => {
    const downloadFormat = `# Recovery phrase for 0x405338…\n${ABANDON_PHRASE}\n`;
    expect(parseRecoveryPhrase(downloadFormat)).toEqual({
      status: "valid",
      mnemonic: ABANDON_PHRASE,
    });
  });

  test("normalizes whitespace, case, and stray punctuation", () => {
    const messy = `   ABANDON\tabandon\nabandon  abandon, abandon abandon abandon abandon abandon abandon abandon about  `;
    const result = parseRecoveryPhrase(messy);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.mnemonic).toBe(ABANDON_PHRASE);
    }
  });

  test("wrong count (too many)", () => {
    expect(
      parseRecoveryPhrase(`${ABANDON_PHRASE} extra extra`),
    ).toEqual({ status: "wrong-count", count: 14 });
  });

  test("invalid-word names the offending token", () => {
    // 12 tokens, but one isn't in the BIP-39 list.
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon xyzzy";
    expect(parseRecoveryPhrase(phrase)).toEqual({
      status: "invalid-word",
      badWord: "xyzzy",
    });
  });

  test("bad-checksum when all words are valid BIP-39 but the combo isn't", () => {
    // 12 valid BIP-39 words that don't form a real phrase (no `about`
    // at the end → checksum will mismatch).
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
    expect(parseRecoveryPhrase(phrase)).toEqual({ status: "bad-checksum" });
  });

  test("freshly generated mnemonics round-trip through the parser", () => {
    for (let i = 0; i < 5; i++) {
      const phrase = Wallet.createRandom().mnemonic!.phrase;
      const result = parseRecoveryPhrase(phrase);
      expect(result).toEqual({ status: "valid", mnemonic: phrase });
    }
  });
});

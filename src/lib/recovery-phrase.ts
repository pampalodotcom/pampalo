import { Mnemonic, LangEn } from "ethers";

// Parser + validator for the input on the Recover account form. Accepts
// both a raw 12-word paste and the contents of a wallet-recovery .txt
// file produced by MnemonicReveal.tsx (which writes a `# Recovery
// phrase for 0x…` comment line above the words).
//
// Returns a discriminated union the UI can switch on rather than a
// throws-on-failure call. The split between `invalid-word`,
// `wrong-count`, and `bad-checksum` exists because each maps to a
// different user-facing message — see ADR 0003 / the recover form for
// the exact copy.

export type ParseResult =
  | { status: "empty" }
  // < 12 tokens parsed so far — UI suppresses validation feedback at
  // this stage so users aren't yelled at while still typing.
  | { status: "partial"; count: number }
  | { status: "valid"; mnemonic: string }
  | { status: "wrong-count"; count: number }
  | { status: "invalid-word"; badWord: string }
  | { status: "bad-checksum" };

const ENGLISH_WORD_COUNT = 12;

// The English BIP-39 wordlist. Lazy-resolved to avoid forcing module
// init at import time (the wordlist is ~16 KB of strings).
let wordlistRef: ReturnType<typeof LangEn.wordlist> | null = null;
function wordlist() {
  if (!wordlistRef) wordlistRef = LangEn.wordlist();
  return wordlistRef;
}

export function parseRecoveryPhrase(input: string): ParseResult {
  const tokens = tokenize(input);
  if (tokens.length === 0) return { status: "empty" };

  // Still typing — don't show any feedback yet.
  if (tokens.length < ENGLISH_WORD_COUNT) {
    return { status: "partial", count: tokens.length };
  }

  if (tokens.length !== ENGLISH_WORD_COUNT) {
    return { status: "wrong-count", count: tokens.length };
  }

  // Word-level check first — if a word isn't in the BIP-39 list, no
  // amount of checksum-massaging will help, and pinpointing the
  // offending word is the most actionable feedback we can give.
  const wl = wordlist();
  for (const token of tokens) {
    if (wl.getWordIndex(token) === -1) {
      return { status: "invalid-word", badWord: token };
    }
  }

  // All words valid; check checksum via ethers. `isValidMnemonic`
  // re-checks the wordlist but that's redundant work we accept for
  // the clarity of using the library entry point.
  const phrase = tokens.join(" ");
  if (!Mnemonic.isValidMnemonic(phrase)) {
    return { status: "bad-checksum" };
  }
  return { status: "valid", mnemonic: phrase };
}

// Tokenizer rules:
//  - lines starting with `#` are stripped (the comment header written
//    by the .txt download flow);
//  - blank lines are ignored;
//  - words are separated by any non-letter run (handles double spaces,
//    tabs, smart quotes pasted from a notes app, etc.);
//  - everything is lowercased — BIP-39 is case-sensitive lowercase.
function tokenize(input: string): string[] {
  return input
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join(" ")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

// scrypt + AES-256-GCM keystore for an agent account's mnemonic.
//
// Modelled on ~/.ssh/: one encrypted file per account under
// ~/.pampalo/accounts/<name>.json. This deliberately reintroduces the
// scrypt-passphrase scheme the *web wallet* forbids (ADR 0002) — but only
// here, because Node has no WebAuthn/PRF authenticator to derive a key
// from. See ADR 0014. This module MUST NEVER be imported by the web bundle.
//
// The plaintext mnemonic is held by the caller transiently; this file only
// ever sees it inside encrypt()/decrypt(). Nothing here logs it.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

// scrypt cost. N=2^17 matches the common Ethereum keystore strength; r/p
// standard. maxmem must clear 128*N*r ≈ 134 MB or scryptSync throws.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };
const KEYSTORE_VERSION = 1;

export type Keystore = {
  version: number;
  name: string;
  /** Public EVM address — for identifying the account without unlocking. */
  address: string;
  kdf: { name: "scrypt"; n: number; r: number; p: number; saltHex: string };
  cipher: "aes-256-gcm";
  ivHex: string;
  ciphertextHex: string;
  tagHex: string;
};

export function accountsDir(dir?: string): string {
  return dir ?? join(homedir(), ".pampalo", "accounts");
}

export function keystorePath(name: string, dir?: string): string {
  return join(accountsDir(dir), `${name}.json`);
}

export async function keystoreExists(
  name: string,
  dir?: string,
): Promise<boolean> {
  try {
    await access(keystorePath(name, dir));
    return true;
  } catch {
    return false;
  }
}

/** Encrypt `mnemonic` under `passphrase` and write the keystore file. */
export async function writeKeystore(opts: {
  name: string;
  mnemonic: string;
  passphrase: string;
  address: string;
  dir?: string;
}): Promise<string> {
  const { name, mnemonic, passphrase, address, dir } = opts;
  const path = keystorePath(name, dir);
  if (await keystoreExists(name, dir)) {
    throw new Error(`account "${name}" already exists at ${path}`);
  }

  const salt = randomBytes(32);
  const key = scryptSync(passphrase.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(mnemonic, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const keystore: Keystore = {
    version: KEYSTORE_VERSION,
    name,
    address,
    kdf: {
      name: "scrypt",
      n: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      saltHex: salt.toString("hex"),
    },
    cipher: "aes-256-gcm",
    ivHex: iv.toString("hex"),
    ciphertextHex: ciphertext.toString("hex"),
    tagHex: tag.toString("hex"),
  };

  await mkdir(dirname(path), { recursive: true });
  // 0600 — owner read/write only, like an SSH private key.
  await writeFile(path, JSON.stringify(keystore, null, 2) + "\n", {
    mode: 0o600,
  });
  return path;
}

/** Read + decrypt the keystore. Throws on a wrong passphrase (the GCM auth
 *  tag fails to verify) — distinguishable from a missing file. */
export async function readKeystore(opts: {
  name: string;
  passphrase: string;
  dir?: string;
}): Promise<{ mnemonic: string; keystore: Keystore }> {
  const { name, passphrase, dir } = opts;
  const path = keystorePath(name, dir);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`no account "${name}" at ${path}`);
  }
  const keystore = JSON.parse(raw) as Keystore;
  if (keystore.version !== KEYSTORE_VERSION) {
    throw new Error(`unsupported keystore version ${keystore.version}`);
  }

  const key = scryptSync(
    passphrase.normalize("NFKC"),
    Buffer.from(keystore.kdf.saltHex, "hex"),
    SCRYPT.keylen,
    { N: keystore.kdf.n, r: keystore.kdf.r, p: keystore.kdf.p, maxmem: SCRYPT.maxmem },
  );

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(keystore.ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(keystore.tagHex, "hex"));
  try {
    const mnemonic = Buffer.concat([
      decipher.update(Buffer.from(keystore.ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
    return { mnemonic, keystore };
  } catch {
    throw new Error("wrong passphrase");
  }
}

import { encrypt, decrypt } from "eciesjs";
import {
  Signer,
  Wallet,
  getBytes,
  hexlify,
  hashMessage,
  SigningKey,
} from "ethers";

// Secret-only ECIES encryption — the format the on-chain NotePayload
// emit carries today. The recipient gets `(encryptedSecret, owner,
// asset_id, asset_amount)`; the `owner` field is the Poseidon
// identifier which is already public on-chain, and the asset/amount
// are also public. Only the `secret` field must be encrypted (it's
// what proves spending authority in ZK).
//
// Distinct from `@pampalo/shared/classes/Note` which packs all four
// fields into one ECIES blob — that format is used by the wallet for
// off-chain note storage.

export interface EncryptedNote {
  encryptedSecret: string;
  owner: string;
  asset_id: string;
  asset_amount: string;
}

export interface DecryptedNote {
  secret: string;
  owner: string;
  asset_id: string;
  asset_amount: string;
}

export class NoteEncryption {
  static async encryptNoteSecret(
    secret: string | bigint,
    recipientPublicKey: string,
  ): Promise<string> {
    const secretBigInt = BigInt(secret);
    const secretHex = "0x" + secretBigInt.toString(16).padStart(64, "0");
    const secretBytes = getBytes(secretHex);
    const encryptedData = encrypt(recipientPublicKey, secretBytes);
    return hexlify(encryptedData);
  }

  static async decryptNoteSecret(
    encryptedSecret: string,
    signer: Signer,
  ): Promise<string> {
    const privateKey = await this.getPrivateKeyFromSigner(signer);
    const encryptedBytes = getBytes(encryptedSecret);
    const decryptedData = decrypt(privateKey, encryptedBytes);
    const decryptedHex = hexlify(decryptedData);
    const secretBigInt = BigInt(decryptedHex);
    return secretBigInt.toString();
  }

  static async getPublicKeyFromAddress(signer: Signer): Promise<string> {
    if (signer instanceof Wallet) {
      const signingKey = new SigningKey(signer.privateKey);
      return signingKey.publicKey;
    }

    const message = "derive_public_key";
    const signature = await signer.signMessage(message);
    const messageHash = hashMessage(message);
    const recoveredKey = SigningKey.recoverPublicKey(messageHash, signature);
    return recoveredKey;
  }

  private static async getPrivateKeyFromSigner(
    signer: Signer,
  ): Promise<string> {
    if (signer instanceof Wallet) {
      return signer.privateKey;
    }
    throw new Error("Signer must be a Wallet instance to access private key");
  }

  static async createEncryptedNote(
    note: {
      secret: string | bigint;
      owner: string;
      asset_id: string;
      asset_amount: string;
    },
    recipientSigner: Signer,
  ): Promise<EncryptedNote> {
    const recipientPublicKey =
      await this.getPublicKeyFromAddress(recipientSigner);
    const encryptedSecret = await this.encryptNoteSecret(
      note.secret,
      recipientPublicKey,
    );

    return {
      encryptedSecret,
      owner: note.owner,
      asset_id: note.asset_id,
      asset_amount: note.asset_amount,
    };
  }

  static async decryptNote(
    encryptedNote: EncryptedNote,
    recipientSigner: Signer,
  ): Promise<DecryptedNote> {
    const decryptedSecret = await this.decryptNoteSecret(
      encryptedNote.encryptedSecret,
      recipientSigner,
    );

    return {
      secret: decryptedSecret,
      owner: encryptedNote.owner,
      asset_id: encryptedNote.asset_id,
      asset_amount: encryptedNote.asset_amount,
    };
  }
}

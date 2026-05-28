import { ethers } from "ethers";

// ECIES encryption of a Pampalo note's four-tuple `(secret, owner,
// asset_id, asset_amount)` against a recipient's envelope key. The
// recipient pulls the encrypted blob from the on-chain ShieldQueued
// (or NotePayload) event and decrypts it with their envelope private
// key to learn the secret needed to spend the note.

export class NoteEncryption {
  static async getPublicKeyFromAddress(signer: ethers.Signer): Promise<string> {
    if (signer instanceof ethers.Wallet) {
      const signingKey = new ethers.SigningKey(signer.privateKey);
      return signingKey.publicKey;
    }
    const message = "derive_public_key";
    const signature = await signer.signMessage(message);
    const messageHash = ethers.hashMessage(message);
    const recoveredKey = ethers.SigningKey.recoverPublicKey(
      messageHash,
      signature,
    );
    return recoveredKey;
  }

  static async encryptNoteData(
    data: {
      secret: string | bigint;
      owner: string | bigint;
      asset_id: string | bigint;
      asset_amount: string | bigint;
    },
    recipientPublicKey: string,
  ): Promise<string> {
    const { encrypt } = await import("eciesjs");

    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "uint256", "uint256"],
      [
        BigInt(data.secret),
        BigInt(data.owner),
        BigInt(data.asset_id),
        BigInt(data.asset_amount),
      ],
    );

    const payloadBytes = ethers.getBytes(payload);
    const encryptedData = encrypt(recipientPublicKey, payloadBytes);
    return ethers.hexlify(encryptedData);
  }

  static async createEncryptedNote(
    note: {
      secret: string | bigint;
      owner: string | bigint;
      asset_id: string | bigint;
      asset_amount: string | bigint;
    },
    recipientSigner: ethers.Signer,
  ): Promise<string> {
    const recipientPublicKey =
      await this.getPublicKeyFromAddress(recipientSigner);
    const encryptedNote = await this.encryptNoteData(note, recipientPublicKey);
    return encryptedNote;
  }
}

export class NoteDecryption {
  static async decryptNoteData(
    encryptedData: string,
    privateKey: string,
  ): Promise<{
    secret: string;
    owner: string;
    asset_id: string;
    asset_amount: string;
  }> {
    try {
      const { decrypt } = await import("eciesjs");

      const cleanEncryptedData = encryptedData.startsWith("0x")
        ? encryptedData.slice(2)
        : encryptedData;

      const cleanPrivateKey = privateKey.startsWith("0x")
        ? privateKey.slice(2)
        : privateKey;

      const encryptedBytes = ethers.getBytes("0x" + cleanEncryptedData);
      const privateKeyBytes = ethers.getBytes("0x" + cleanPrivateKey);

      const decryptedBytes = decrypt(privateKeyBytes, encryptedBytes);

      const decryptedHex = ethers.hexlify(decryptedBytes);

      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256", "uint256", "uint256", "uint256"],
        decryptedHex,
      );

      return {
        secret: decoded[0].toString(),
        owner: decoded[1].toString(),
        asset_id: decoded[2].toString(),
        asset_amount: decoded[3].toString(),
      };
    } catch (error) {
      throw new Error(
        `Failed to decrypt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  static async decryptEncryptedNote(
    encryptedNote: string,
    privateKey: string,
  ): Promise<{
    secret: string;
    owner: string;
    asset_id: string;
    asset_amount: string;
  }> {
    return await this.decryptNoteData(encryptedNote, privateKey);
  }
}

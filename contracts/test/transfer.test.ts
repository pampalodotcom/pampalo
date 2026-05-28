import { getShieldDetails, shieldAndExecute } from "@/helpers/functions/shield.js";
import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { getNullifier } from "@/helpers/functions/get-nullifier.js";
import {
  getTransferDetails,
  transfer,
} from "@/helpers/functions/transfer.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import {
  createInputNote,
  createOutputNote,
  emptyInputNote,
  emptyOutputNote,
} from "@/helpers/note-formatting.js";
import { NoteEncryption } from "@/helpers/note-sharing.js";
import { PoseidonMerkleTree } from "@pampalo/shared/classes/PoseidonMerkleTree";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers, Wallet } from "ethers";

// Exercises the `transfer` circuit: spend one shielded input note,
// produce two output notes (change for self, send to a recipient).

describe("transfer", () => {
  let Signers: ethers.Signer[];

  let pampalo: ethers.Contract;
  let tree: PoseidonMerkleTree;

  let usdcDeployment: ethers.Contract;

  let deployer1Secret: string;
  let deployer2Secret: string;

  beforeEach(async () => {
    ({
      Signers,
      usdcDeployment,
      pampalo,
      tree,
      deployer1Secret,
      deployer2Secret,
    } = await getTestingAPI());
  });

  it("transfer splits a shielded note into change + send", async () => {
    const assetId = await usdcDeployment.getAddress();
    const assetAmount = 5_000_000n;

    const secret =
      2389312107716289199307843900794656424062350252250388738019021107824217896920n;
    const ownerSecret =
      10036677144260647934022413515521823129584317400947571241312859176539726523915n;
    const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

    // Seed: shield + execute immediately so the leaf is in the tree.
    const { proof: shieldProof } = await getShieldDetails({
      assetId,
      assetAmount,
      secret,
      owner,
    });

    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);
    await shieldAndExecute(pampalo, Signers[0], () =>
      pampalo.shield(
        assetId,
        assetAmount,
        shieldProof.proof,
        shieldProof.publicInputs,
        "0x",
      ),
    );
    await tree.insert(shieldProof.publicInputs[0], 0);

    // Build the transfer witness — one input, two outputs (change + send)
    const merkleProof = await tree.getProof(0);
    const leafIndex = 0n;

    const aliceInputNote = createInputNote(
      assetId,
      assetAmount,
      owner,
      ownerSecret,
      secret,
      leafIndex,
      merkleProof.siblings,
      merkleProof.indices,
    );

    const aliceInputNullifier = await getNullifier(
      leafIndex,
      owner,
      secret,
      assetId,
      assetAmount,
    );

    const alice_amount = 3_000_000n;
    const alice_note_secret =
      19536471094918068928039225564664574556680178861106125446000998678966251111926n;
    const aliceOutputNote = createOutputNote(
      owner,
      alice_note_secret,
      assetId,
      alice_amount,
    );
    const aliceOutputHash = await getNoteHash(aliceOutputNote);

    const bobOwnerSecret =
      6955001134965379637962992480442037189090898019061077075663294923529403402038n;
    const bobOwner = poseidon2Hash([bobOwnerSecret]).toString();
    const bobNoteSecret =
      3957740128091467064337395812164919758932045173069261808814882570720300029469n;
    const bobAmount = 2_000_000n;
    const bobOutputNote = createOutputNote(
      bobOwner,
      bobNoteSecret,
      assetId,
      bobAmount,
    );
    const bobOutputHash = await getNoteHash(bobOutputNote);

    const inputNotes = [aliceInputNote, emptyInputNote, emptyInputNote];
    const outputNotes = [aliceOutputNote, bobOutputNote, emptyOutputNote];
    const nullifiers = [aliceInputNullifier, 0n, 0n];
    const outputHashes = [aliceOutputHash, bobOutputHash, 0n];

    const { proof: transferProof } = await getTransferDetails(
      tree,
      inputNotes,
      nullifiers,
      outputNotes,
      outputHashes,
    );

    const aliceEncryptedNote = await NoteEncryption.createEncryptedNote(
      aliceOutputNote,
      new Wallet(deployer1Secret),
    );
    const bobEncryptedNote = await NoteEncryption.createEncryptedNote(
      bobOutputNote,
      new Wallet(deployer2Secret),
    );

    const rootBefore = await pampalo.currentRoot();
    await transfer(pampalo, transferProof, Signers[10], [
      aliceEncryptedNote,
      bobEncryptedNote,
      "0x",
    ]);
    const rootAfter = await pampalo.currentRoot();

    // Root advanced (new leaves inserted)
    expect(rootAfter).to.not.equal(rootBefore);
    // Input note is now nullified
    expect(
      await pampalo.nullifierUsed(
        "0x" + aliceInputNullifier.toString(16).padStart(64, "0"),
      ),
    ).to.equal(true);

    // Off-chain mirror tracks the new leaves
    await tree.insert(aliceOutputHash.toString(), 1);
    await tree.insert(bobOutputHash.toString(), 2);
  });
});

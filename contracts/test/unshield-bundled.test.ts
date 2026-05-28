import { getShieldDetails, shieldAndExecute } from "@/helpers/functions/shield.js";
import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { getNullifier } from "@/helpers/functions/get-nullifier.js";
import {
  getUnshieldBundledDetails,
  unshieldBundled,
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

// Exercises `unshieldBundled` — one proof that produces both an
// internal note (change for the spender) and an external payout to a
// public address.

describe("unshieldBundled", () => {
  let Signers: ethers.Signer[];

  let pampalo: ethers.Contract;
  let tree: PoseidonMerkleTree;
  let usdcDeployment: ethers.Contract;
  let deployer1Secret: string;

  beforeEach(async () => {
    ({ Signers, usdcDeployment, pampalo, tree, deployer1Secret } =
      await getTestingAPI());
  });

  it("spends one shielded input → one internal change note + one external payout", async () => {
    const assetId = await usdcDeployment.getAddress();
    const assetAmount = 5_000_000n;

    const secret =
      2389312107716289199307843900794656424062350252250388738019021107824217896920n;
    const ownerSecret =
      10036677144260647934022413515521823129584317400947571241312859176539726523915n;
    const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

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

    // Bob receives 2 USDC at an external address (slot 0 of outputs)
    const bobExternalAddress = await Signers[9].getAddress();
    const bobAmount = 2_000_000n;
    const bobOutputNote = createOutputNote(
      0n,
      0n,
      assetId,
      bobAmount,
      BigInt(bobExternalAddress),
    );

    // Alice keeps 3 USDC as an internal change note (slot 1 of outputs)
    const aliceOutputNote = createOutputNote(
      owner,
      alice_note_secret,
      assetId,
      alice_amount,
      0n,
    );
    const aliceOutputHash = await getNoteHash(aliceOutputNote);

    const inputNotes = [aliceInputNote, emptyInputNote, emptyInputNote];
    const outputNotes = [bobOutputNote, aliceOutputNote, emptyOutputNote];
    const nullifiers = [aliceInputNullifier, 0n, 0n];
    const outputHashes = [0n, aliceOutputHash, 0n];

    const exitAssets = [assetId, 0n, 0n];
    const exitAmounts = [bobAmount, 0n, 0n];
    const exitAddresses = [BigInt(bobExternalAddress), 0n, 0n];
    const exitAddressHashes = [
      poseidon2Hash([BigInt(bobExternalAddress)]).toString(),
      0n,
      0n,
    ];

    const { proof: unshieldBundledProof } = await getUnshieldBundledDetails(
      tree,
      inputNotes,
      nullifiers,
      outputNotes,
      outputHashes,
      exitAssets,
      exitAmounts,
      exitAddresses,
      exitAddressHashes,
    );

    const aliceEncryptedNote = await NoteEncryption.createEncryptedNote(
      aliceOutputNote,
      new Wallet(deployer1Secret),
    );

    const bobBalanceBefore = await usdcDeployment.balanceOf(bobExternalAddress);

    await unshieldBundled(pampalo, unshieldBundledProof, Signers[10], [
      "0x",
      aliceEncryptedNote,
      "0x",
    ]);

    await tree.insert(aliceOutputHash.toString(), 1);

    const bobBalanceAfter = await usdcDeployment.balanceOf(bobExternalAddress);
    expect(bobBalanceAfter).to.equal(bobBalanceBefore + bobAmount);
  });
});

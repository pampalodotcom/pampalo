import { approve } from "@/helpers/functions/approve.js";
import {
  getShieldDetails,
  shieldAndExecute,
} from "@/helpers/functions/shield.js";
import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { getNullifier } from "@/helpers/functions/get-nullifier.js";
import { getTransferDetails, transfer } from "@/helpers/functions/transfer.js";
import { getUnshieldDetails } from "@/helpers/functions/unshield.js";
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
import { ethers, parseEther, parseUnits, Wallet } from "ethers";

// Exercises the `unshield` circuit: shield → transfer → unshield to an
// external address. Two scenarios: ERC-20 and native ETH.

describe("unshield", () => {
  let Signers: ethers.Signer[];

  let pampalo: ethers.Contract;
  let tree: PoseidonMerkleTree;

  let usdcDeployment: ethers.Contract;

  let deployer1Secret: string;
  let deployer2Secret: string;

  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

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

  it("unshields ERC-20 to an external address", async () => {
    const assetId = await usdcDeployment.getAddress();
    const assetAmount = parseUnits("5", 6); // 5 USDC

    // Shield 5 USDC
    const { proof: shieldProof } = await getShieldDetails({
      assetId,
      assetAmount,
      secret,
      owner,
    });

    await approve(
      Signers[0],
      await usdcDeployment.getAddress(),
      await pampalo.getAddress(),
      assetAmount,
    );

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

    // Transfer to split into Alice change + Bob receivable note
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
    const aliceInputNullifier = await getNullifier(aliceInputNote);

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

    await transfer(pampalo, transferProof, Signers[10], [
      aliceEncryptedNote,
      bobEncryptedNote,
      "0x",
    ]);

    await tree.insert(transferProof.publicInputs[4], 1);
    await tree.insert(transferProof.publicInputs[5], 2);

    // Now Bob unshields his note to an external EVM address
    const bobProof = await tree.getProof(2);

    const bobInputNote = createInputNote(
      BigInt(assetId),
      bobAmount,
      bobOwner,
      bobOwnerSecret,
      bobNoteSecret,
      2n,
      bobProof.siblings,
      bobProof.indices,
    );

    const bobInputNullifier = await getNullifier(bobInputNote);
    const unshieldInputNotes = [bobInputNote, emptyInputNote, emptyInputNote];
    const unshieldNullifiers = [
      "0x" + bobInputNullifier.toString(16),
      "0",
      "0",
    ];
    const exitAssets = [assetId, "0", "0"];
    const exitAmounts = [
      "0x" + BigInt(bobInputNote.asset_amount).toString(16),
      "0",
      "0",
    ];
    const exitAddresses = [Signers[9].address, "0", "0"];
    const exitAddressHashes = [
      poseidon2Hash([BigInt(Signers[9].address)]).toString(),
      "0",
      "0",
    ];

    const usdcBalanceBefore = await usdcDeployment.balanceOf(
      Signers[9].address,
    );

    const { proof: unshieldProof } = await getUnshieldDetails(
      tree,
      unshieldInputNotes,
      unshieldNullifiers,
      exitAssets,
      exitAmounts,
      exitAddresses,
      exitAddressHashes,
    );

    await pampalo.unshield(unshieldProof.proof, unshieldProof.publicInputs);

    const usdcBalanceAfter = await usdcDeployment.balanceOf(Signers[9].address);
    expect(usdcBalanceAfter).to.equal(usdcBalanceBefore + bobAmount);

    // unshieldBudget() reflects the charge against the unshield bucket
    // (msg.sender = Signers[0]). 2 USDC * 100 cents = 200 cents used,
    // against the $200 default cap. Proves the view reads unshieldUsage,
    // not shieldUsage.
    const [uCap, uUsed, uRemaining] = await pampalo.unshieldBudget(
      Signers[0].address,
    );
    expect(uCap).to.equal(20_000n);
    expect(uUsed).to.equal(200n);
    expect(uRemaining).to.equal(20_000n - 200n);
    // The shield bucket for the same address is independent — the shield
    // earlier in this flow charged it separately, so it is NOT 200.
    const [, sUsed] = await pampalo.shieldBudget(Signers[0].address);
    expect(sUsed).to.not.equal(uUsed);
  });

  it("unshields native ETH to an external address", async () => {
    const assetAmount = parseEther("1");
    const ethAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    const { proof: shieldProof } = await getShieldDetails({
      assetId: ethAddress,
      assetAmount,
      secret,
      owner,
    });

    await shieldAndExecute(pampalo, Signers[0], () =>
      pampalo.shieldNative(shieldProof.proof, shieldProof.publicInputs, "0x", {
        value: assetAmount,
      }),
    );

    await tree.insert(shieldProof.publicInputs[0], 0);

    const merkleProof = await tree.getProof(0);
    const leafIndex = 0n;

    const inputNote = createInputNote(
      ethAddress,
      assetAmount,
      owner,
      ownerSecret,
      secret,
      leafIndex,
      merkleProof.siblings,
      merkleProof.indices,
    );
    const aliceInputNullifier = await getNullifier(inputNote);

    const inputNotes = [inputNote, emptyInputNote, emptyInputNote];
    const nullifiers = ["0x" + aliceInputNullifier.toString(16), "0", "0"];
    const exitAddresses = [Signers[9].address, "0", "0"];
    const exitAddressHashes = [
      poseidon2Hash([BigInt(Signers[9].address)]).toString(),
      "0",
      "0",
    ];
    const exitAssets = [ethAddress, "0", "0"];
    const exitAmounts = ["0x" + BigInt(assetAmount).toString(16), "0", "0"];

    const provider = Signers[9].provider!;
    const balanceBefore = await provider.getBalance(Signers[9].address);

    const { proof: unshieldProof } = await getUnshieldDetails(
      tree,
      inputNotes,
      nullifiers,
      exitAssets,
      exitAmounts,
      exitAddresses,
      exitAddressHashes,
    );

    await pampalo.unshield(unshieldProof.proof, unshieldProof.publicInputs);

    const balanceAfter = await provider.getBalance(Signers[9].address);
    expect(balanceAfter).to.equal(balanceBefore + assetAmount);
  });
});

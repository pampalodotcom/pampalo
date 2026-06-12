import { approve } from "@/helpers/functions/approve.js";
import {
  getShieldDetails,
  shieldAndExecute,
} from "@/helpers/functions/shield.js";
import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { getNullifier } from "@/helpers/functions/get-nullifier.js";
import { getTransferDetails, transfer } from "@/helpers/functions/transfer.js";
import { getRedeemDetails } from "@/helpers/functions/redeem.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import {
  createInputNote,
  createOutputNote,
  emptyInputNote,
  emptyOutputNote,
} from "@/helpers/note-formatting.js";
import RedeemVerifierModule from "@/ignition/modules/RedeemVerifier.js";
import { PoseidonMerkleTree } from "@pampalo/shared/classes/PoseidonMerkleTree";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers, parseUnits, ZeroHash } from "ethers";

// Exercises the private-payment library end-to-end:
//   shield -> transfer (buyer pays a note to the merchant) -> redeem
//   proof -> MockShop.purchase. Plus the disable switch and every
//   binding/double-spend revert path.

describe("private payment (PampaloPayments + acceptor)", function () {
  this.timeout(300_000);

  let connection: Awaited<ReturnType<typeof getTestingAPI>>["connection"];
  let Signers: ethers.Signer[];
  let pampalo: ethers.Contract;
  let tree: PoseidonMerkleTree;
  let usdcDeployment: ethers.Contract;

  let pampaloPayments: ethers.Contract;
  let shop: ethers.Contract;

  // Buyer-side note material.
  const buyerOwnerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const buyerOwner = BigInt(poseidon2Hash([buyerOwnerSecret]).toString());
  const buyerShieldSecret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;

  // Merchant identity: the buyer only needs the public merchantId to
  // address the payment note; owner_secret stays with the merchant.
  const merchantOwnerSecret =
    6955001134965379637962992480442037189090898019061077075663294923529403402038n;
  const merchantId = BigInt(poseidon2Hash([merchantOwnerSecret]).toString());

  // The note secret the buyer chooses for the merchant's payment note --
  // the buyer knows it (they created the note) and uses it to prove
  // membership at redeem time.
  const paymentSecret =
    3957740128091467064337395812164919758932045173069261808814882570720300029469n;

  const PRICE = parseUnits("5", 6); // 5 USDC
  const ITEM_PAID = 1n; // bound reference in the proof
  const ITEM_SAME_PRICE = 7n; // same price, different reference
  const ITEM_DIFF_PRICE = 9n;

  // Re-used across all cases so we only generate the (expensive) proof
  // once.
  let redeemProof: { proof: string; publicInputs: string[] };
  let redeemNullifier: bigint;
  let buyerAddress: string;

  before(async () => {
    ({ connection, Signers, usdcDeployment, pampalo, tree } =
      await getTestingAPI());

    buyerAddress = await Signers[0].getAddress();
    const assetId = await usdcDeployment.getAddress();

    // ── Deploy the redeem verifier + payments singleton + shop ──
    const { redeemVerifier } =
      await connection.ignition.deploy(RedeemVerifierModule);

    const PaymentsFactory =
      await connection.ethers.getContractFactory("PampaloPayments");
    pampaloPayments = (await PaymentsFactory.deploy(
      await pampalo.getAddress(),
      await redeemVerifier.getAddress(),
    )) as unknown as ethers.Contract;
    await pampaloPayments.waitForDeployment();

    const ShopFactory = await connection.ethers.getContractFactory("MockShop");
    shop = (await ShopFactory.deploy(
      await pampaloPayments.getAddress(),
      merchantId,
      buyerAddress, // admin
      assetId, // payAsset
    )) as unknown as ethers.Contract;
    await shop.waitForDeployment();

    await shop.setPrice(ITEM_PAID, PRICE);
    await shop.setPrice(ITEM_SAME_PRICE, PRICE);
    await shop.setPrice(ITEM_DIFF_PRICE, PRICE * 2n);

    // ── Buyer shields PRICE USDC into a note they own ──
    const { proof: shieldProof } = await getShieldDetails({
      assetId,
      assetAmount: PRICE,
      secret: buyerShieldSecret,
      owner: buyerOwner,
    });

    await approve(
      Signers[0],
      assetId,
      await pampalo.getAddress(),
      PRICE,
    );
    await shieldAndExecute(pampalo, Signers[0], () =>
      pampalo.shield(
        assetId,
        PRICE,
        shieldProof.proof,
        shieldProof.publicInputs,
        "0x",
      ),
    );
    await tree.insert(shieldProof.publicInputs[0], 0);

    // ── Buyer transfers the whole note to the merchant ──
    const buyerInputNote = createInputNote(
      assetId,
      PRICE,
      buyerOwner,
      buyerOwnerSecret,
      buyerShieldSecret,
      0n,
      (await tree.getProof(0)).siblings,
      (await tree.getProof(0)).indices,
    );
    const buyerInputNullifier = await getNullifier(buyerInputNote);

    const merchantNote = createOutputNote(
      merchantId,
      paymentSecret,
      assetId,
      PRICE,
    );
    const merchantNoteHash = await getNoteHash(merchantNote);

    const { proof: transferProof } = await getTransferDetails(
      tree,
      [buyerInputNote, emptyInputNote, emptyInputNote],
      [buyerInputNullifier, 0n, 0n],
      [merchantNote, emptyOutputNote, emptyOutputNote],
      [merchantNoteHash, 0n, 0n],
    );

    await transfer(pampalo, transferProof, Signers[10], ["0x", "0x", "0x"]);
    await tree.insert(transferProof.publicInputs[4], 1);

    // ── Buyer builds the redeem proof for the merchant's note ──
    const result = await getRedeemDetails(
      tree,
      {
        assetId: BigInt(assetId),
        assetAmount: PRICE,
        merchantId,
        secret: paymentSecret,
        leafIndex: 1n,
      },
      buyerAddress, // recipient
      await shop.getAddress(), // consumer
      ITEM_PAID, // reference
    );
    redeemProof = result.proof as never;
    redeemNullifier = result.redeemNullifier;
  });

  it("rejects an unknown root", async () => {
    const mangled = [...redeemProof.publicInputs];
    mangled[0] = ZeroHash.replace(/0$/, "1"); // not a known root
    await expect(
      pampaloPayments.verifyAndBurn(
        redeemProof.proof,
        mangled,
        merchantId,
        await usdcDeployment.getAddress(),
        PRICE,
        buyerAddress,
        ethers.zeroPadValue(ethers.toBeHex(ITEM_PAID), 32),
      ),
    ).to.be.revertedWith("Invalid Root!");
  });

  it("rejects a caller that is not the bound consumer (anti-grief)", async () => {
    // Called directly by the buyer EOA instead of via the shop, so
    // msg.sender != bound consumer. This is the mempool burn-without-
    // delivery guard.
    await expect(
      pampaloPayments
        .connect(Signers[0])
        .verifyAndBurn(
          redeemProof.proof,
          redeemProof.publicInputs,
          merchantId,
          await usdcDeployment.getAddress(),
          PRICE,
          buyerAddress,
          ethers.zeroPadValue(ethers.toBeHex(ITEM_PAID), 32),
        ),
    ).to.be.revertedWith("consumer mismatch");
  });

  it("rejects a wrong amount (item priced differently)", async () => {
    await expect(
      shop
        .connect(Signers[0])
        .purchase(
          ITEM_DIFF_PRICE,
          true,
          redeemProof.proof,
          redeemProof.publicInputs,
        ),
    ).to.be.revertedWith("amount mismatch");
  });

  it("rejects a wrong reference (same price, different item)", async () => {
    await expect(
      shop
        .connect(Signers[0])
        .purchase(
          ITEM_SAME_PRICE,
          true,
          redeemProof.proof,
          redeemProof.publicInputs,
        ),
    ).to.be.revertedWith("ref mismatch");
  });

  it("rejects when the vendor has disabled private payments", async () => {
    await shop.connect(Signers[0]).setPrivatePaymentsEnabled(false);
    await expect(
      shop
        .connect(Signers[0])
        .purchase(ITEM_PAID, true, redeemProof.proof, redeemProof.publicInputs),
    ).to.be.revertedWith("private payments disabled");
    await shop.connect(Signers[0]).setPrivatePaymentsEnabled(true);
  });

  it("only lets the admin toggle private payments", async () => {
    await expect(
      shop.connect(Signers[1]).setPrivatePaymentsEnabled(false),
    ).to.be.revertedWith("not private payment admin");
  });

  it("settles a valid private payment and delivers the item", async () => {
    await expect(
      shop
        .connect(Signers[0])
        .purchase(ITEM_PAID, true, redeemProof.proof, redeemProof.publicInputs),
    )
      .to.emit(shop, "Delivered")
      .withArgs(ITEM_PAID, buyerAddress, true);

    expect(await shop.sold(ITEM_PAID)).to.equal(1n);
    expect(
      await pampaloPayments.redeemNullifierUsed(
        ethers.zeroPadValue(ethers.toBeHex(redeemNullifier), 32),
      ),
    ).to.equal(true);
  });

  it("rejects a second redemption of the same payment (double-spend)", async () => {
    await expect(
      shop
        .connect(Signers[0])
        .purchase(ITEM_PAID, true, redeemProof.proof, redeemProof.publicInputs),
    ).to.be.revertedWith("Already redeemed");
  });
});

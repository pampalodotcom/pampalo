import { getShieldDetails } from "@/helpers/functions/shield.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers, id } from "ethers";

// Shield queue lifecycle: queue → wait → execute (or cancel / contest).
// Time travel via Hardhat 3's networkHelpers.time.increase lets us
// cross the unlock boundary without actually sleeping.

describe("shield wait queue", () => {
  let pampalo: ethers.Contract;
  let usdcDeployment: ethers.Contract;
  let Signers: ethers.Signer[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let connection: any;

  const VIGILANT_CITIZEN_ROLE = id("VIGILANT_CITIZEN_ROLE");

  const assetAmount = 5_000_000n;
  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

  before(async () => {
    ({ pampalo, Signers, usdcDeployment, connection } = await getTestingAPI());
  });

  const buildShield = async () => {
    const assetId = await usdcDeployment.getAddress();
    const { proof } = await getShieldDetails({
      assetId,
      assetAmount,
      secret,
      owner,
    });
    return { assetId, proof };
  };

  const advanceSeconds = async (n: number) => {
    await connection.networkHelpers.time.increase(n);
  };

  it("shield escrows funds, queues the leaf, and emits ShieldQueued — leaf not yet inserted", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const usdcBalanceBefore = await usdcDeployment.balanceOf(
      Signers[0].address,
    );
    const rootBefore = await pampalo.currentRoot();

    const id_ = (await pampalo.nextPendingId()) as bigint;
    const tx = await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );
    await expect(tx).to.emit(pampalo, "ShieldQueued");

    const usdcBalanceAfter = await usdcDeployment.balanceOf(Signers[0].address);
    expect(usdcBalanceAfter).to.equal(usdcBalanceBefore - assetAmount);

    // Leaf NOT yet inserted — root unchanged
    expect(await pampalo.currentRoot()).to.equal(rootBefore);

    const pending = await pampalo.pendingShields(id_);
    expect(pending.shielder).to.equal(Signers[0].address);
    expect(pending.cancelled).to.equal(false);
  });

  it("executeShield reverts before unlockTime", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    await expect(pampalo.executeShield(id_)).to.be.revertedWith(
      "still in wait",
    );
  });

  it("executeShield after unlockTime inserts the leaf", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    const rootBefore = await pampalo.currentRoot();
    await advanceSeconds(3601); // wait is 1 hour
    await pampalo.executeShield(id_);
    const rootAfter = await pampalo.currentRoot();
    expect(rootAfter).to.not.equal(rootBefore);
  });

  it("cancelShield refunds the escrowed funds to the shielder", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const usdcBefore = await usdcDeployment.balanceOf(Signers[0].address);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    await pampalo.cancelShield(id_);

    const usdcAfter = await usdcDeployment.balanceOf(Signers[0].address);
    expect(usdcAfter).to.equal(usdcBefore);

    const pending = await pampalo.pendingShields(id_);
    expect(pending.cancelled).to.equal(true);
  });

  it("non-shielder cannot cancelShield", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    const stranger = Signers[2];
    await expect(
      pampalo.connect(stranger).cancelShield(id_),
    ).to.be.revertedWith("not shielder");

    await pampalo.cancelShield(id_); // cleanup
  });

  it("non-citizen cannot contestShield; citizen can", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    const stranger = Signers[3];
    await expect(pampalo.connect(stranger).contestShield(id_, "ofac listed")).to
      .be.rejected;

    // Grant the citizen role and contest
    await pampalo.grantRole(VIGILANT_CITIZEN_ROLE, stranger.address);
    const balanceBefore = await usdcDeployment.balanceOf(Signers[0].address);

    const tx = await pampalo
      .connect(stranger)
      .contestShield(id_, "ofac listed");
    await expect(tx)
      .to.emit(pampalo, "ShieldContested")
      .withArgs(id_, stranger.address, "ofac listed");

    const balanceAfter = await usdcDeployment.balanceOf(Signers[0].address);
    expect(balanceAfter).to.equal(balanceBefore + assetAmount);
  });

  it("contestShield requires a non-empty reason", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    await expect(pampalo.contestShield(id_, "")).to.be.revertedWith(
      "reason required",
    );

    await pampalo.cancelShield(id_); // cleanup
  });

  it("executeShieldImmediate skips the wait (booth bypass)", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    const rootBefore = await pampalo.currentRoot();
    await pampalo.executeShieldImmediate(id_);
    const rootAfter = await pampalo.currentRoot();
    expect(rootAfter).to.not.equal(rootBefore);
  });

  it("setShieldWaitTime enforces MIN_SHIELD_WAIT_TIME floor", async () => {
    await expect(pampalo.setShieldWaitTime(0)).to.be.revertedWith(
      "wait too short",
    );
    await expect(pampalo.setShieldWaitTime(30)).to.be.revertedWith(
      "wait too short",
    );
    // 60s is at the floor — should succeed
    await pampalo.setShieldWaitTime(60);
    expect(await pampalo.shieldWaitTime()).to.equal(60n);
    // Restore default
    await pampalo.setShieldWaitTime(3600);
  });

  it("cancelShield succeeds after the unlock window — shielder reclaims escrow before finalise", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const usdcBefore = await usdcDeployment.balanceOf(Signers[0].address);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    // Past the wait — still cancellable (funds are escrowed until execute).
    await advanceSeconds(3601);
    await pampalo.cancelShield(id_);

    const usdcAfter = await usdcDeployment.balanceOf(Signers[0].address);
    expect(usdcAfter).to.equal(usdcBefore); // fully refunded

    const pending = await pampalo.pendingShields(id_);
    expect(pending.cancelled).to.equal(true);
  });

  it("cancelShield reverts once the shield has been executed", async () => {
    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      assetAmount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    await advanceSeconds(3601);
    await pampalo.executeShield(id_);

    // Pending storage is freed on execute → cancel can't find the shielder.
    await expect(pampalo.cancelShield(id_)).to.be.revertedWith("not shielder");
  });
});

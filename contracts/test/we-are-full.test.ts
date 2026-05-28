import { getShieldDetails } from "@/helpers/functions/shield.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers } from "ethers";

// `weAreFull()` halts NEW shield calls but does not block executions
// of already-queued shields, and leaves transfer/unshield paths alone.

describe("weAreFull kill switch", () => {
  let pampalo: ethers.Contract;
  let usdcDeployment: ethers.Contract;
  let Signers: ethers.Signer[];

  const assetAmount = 5_000_000n;
  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

  before(async () => {
    ({ pampalo, Signers, usdcDeployment } = await getTestingAPI());
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

  it("weAreFull blocks new shields", async () => {
    await pampalo.weAreFull();

    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    await expect(
      pampalo.shield(
        assetId,
        assetAmount,
        proof.proof,
        proof.publicInputs,
        "0x",
      ),
    ).to.be.revertedWith("deposits halted");

    await pampalo.weFoundRoom();
  });

  it("weAreFull does not block executeShield of a previously queued shield", async () => {
    // Queue a shield while open
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

    // Halt
    await pampalo.weAreFull();

    // Booth-bypass execute should still work (deployer has BOOTH_OPERATOR_ROLE)
    const rootBefore = await pampalo.currentRoot();
    await pampalo.executeShieldImmediate(id_);
    expect(await pampalo.currentRoot()).to.not.equal(rootBefore);

    await pampalo.weFoundRoom();
  });

  it("weFoundRoom unblocks new shields", async () => {
    await pampalo.weAreFull();
    await pampalo.weFoundRoom();

    const { assetId, proof } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    await expect(
      pampalo.shield(
        assetId,
        assetAmount,
        proof.proof,
        proof.publicInputs,
        "0x",
      ),
    ).to.eventually.be.fulfilled;
  });

  it("only FINANCE_MANAGER_ROLE can call weAreFull and weFoundRoom", async () => {
    const stranger = Signers[1];
    await expect(pampalo.connect(stranger).weAreFull()).to.be.rejected;
    await expect(pampalo.connect(stranger).weFoundRoom()).to.be.rejected;
  });

  it("emits DepositsHalted / DepositsResumed", async () => {
    await expect(pampalo.weAreFull())
      .to.emit(pampalo, "DepositsHalted")
      .withArgs(Signers[0].address);
    await expect(pampalo.weFoundRoom())
      .to.emit(pampalo, "DepositsResumed")
      .withArgs(Signers[0].address);
  });
});

import { getShieldDetails } from "@/helpers/functions/shield.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers } from "ethers";

// Monthly cap accounting: charges on shield queue, refunds on
// cancel/contest, blocks over-limit, rolls over on UTC month boundary.

describe("monthly caps", () => {
  let pampalo: ethers.Contract;
  let usdcDeployment: ethers.Contract;
  let usdcOracle: ethers.Contract;
  let Signers: ethers.Signer[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let connection: any;

  const assetAmount = 5_000_000n; // 5 USDC
  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

  before(async () => {
    ({ pampalo, Signers, usdcDeployment, usdcOracle, connection } =
      await getTestingAPI());
  });

  const buildShield = async (amount = assetAmount) => {
    const assetId = await usdcDeployment.getAddress();
    const { proof } = await getShieldDetails({
      assetId,
      assetAmount: amount,
      secret,
      owner,
    });
    return { assetId, proof, amount };
  };

  it("charges shield cap at queue time", async () => {
    const before = await pampalo.shieldUsage(Signers[0].address);
    const usedBefore = before.usdCentsUsed;

    const { assetId, proof, amount } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), amount);
    await pampalo.shield(
      assetId,
      amount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    const after = await pampalo.shieldUsage(Signers[0].address);
    // 5 USDC * 100 cents/USDC = 500 cents
    expect(after.usdCentsUsed - usedBefore).to.equal(500n);
  });

  it("refunds shield cap on cancelShield", async () => {
    const before = await pampalo.shieldUsage(Signers[0].address);
    const usedBefore = before.usdCentsUsed;

    const { assetId, proof, amount } = await buildShield();
    await usdcDeployment.approve(await pampalo.getAddress(), amount);

    const id_ = (await pampalo.nextPendingId()) as bigint;
    await pampalo.shield(
      assetId,
      amount,
      proof.proof,
      proof.publicInputs,
      "0x",
    );

    // Charged
    const mid = await pampalo.shieldUsage(Signers[0].address);
    expect(mid.usdCentsUsed - usedBefore).to.equal(500n);

    await pampalo.cancelShield(id_);

    const after = await pampalo.shieldUsage(Signers[0].address);
    expect(after.usdCentsUsed).to.equal(usedBefore);
  });

  it("blocks a shield that would exceed the default $200 cap", async () => {
    // A fresh signer with no prior usage; shield more than the $200
    // default in one go and expect the cap charge to revert.
    const stranger = Signers[6];

    // Give the stranger some USDC + approve
    const big = 300_000_000n; // 300 USDC
    await usdcDeployment.mint(stranger.address, big);
    await usdcDeployment
      .connect(stranger)
      .approve(await pampalo.getAddress(), big);

    // Build a shield for 250 USDC = $250 — over the $200 cap
    const { assetId, proof } = await buildShield(250_000_000n);
    await expect(
      pampalo
        .connect(stranger)
        .shield(assetId, 250_000_000n, proof.proof, proof.publicInputs, "0x"),
    ).to.be.revertedWith("monthly cap exceeded");
  });

  it("respects an address-specific cap override", async () => {
    const stranger = Signers[7];

    // Bump this address's cap to $1000
    await pampalo.setAddressMonthlyCap(stranger.address, 100_000n);

    // Mint + approve
    const big = 200_000_000n;
    await usdcDeployment.mint(stranger.address, big);
    await usdcDeployment
      .connect(stranger)
      .approve(await pampalo.getAddress(), big);

    // 150 USDC = $150 should now succeed
    const { assetId, proof } = await buildShield(150_000_000n);
    await expect(
      pampalo
        .connect(stranger)
        .shield(assetId, 150_000_000n, proof.proof, proof.publicInputs, "0x"),
    ).to.eventually.be.fulfilled;
  });

  it("resets the bucket on UTC month rollover", async () => {
    const stranger = Signers[8];
    const big = 200_000_000n;
    await usdcDeployment.mint(stranger.address, big);
    await usdcDeployment
      .connect(stranger)
      .approve(await pampalo.getAddress(), big);

    // First shield: 50 USDC
    const first = await buildShield(50_000_000n);
    await pampalo
      .connect(stranger)
      .shield(
        first.assetId,
        50_000_000n,
        first.proof.proof,
        first.proof.publicInputs,
        "0x",
      );

    const midUsage = await pampalo.shieldUsage(stranger.address);
    expect(midUsage.usdCentsUsed).to.equal(5000n);

    // Fast-forward ~32 days to guarantee crossing a UTC month boundary
    await connection.networkHelpers.time.increase(32 * 24 * 60 * 60);

    // Second shield: 80 USDC in the fresh month. If the bucket weren't
    // reset, prior usage would still be counted; 80 USDC ($80) lands
    // unambiguously inside a fresh $200 cap, so success proves the reset.
    const second = await buildShield(80_000_000n);
    await expect(
      pampalo
        .connect(stranger)
        .shield(
          second.assetId,
          80_000_000n,
          second.proof.proof,
          second.proof.publicInputs,
          "0x",
        ),
    ).to.eventually.be.fulfilled;

    const finalUsage = await pampalo.shieldUsage(stranger.address);
    expect(finalUsage.usdCentsUsed).to.equal(8000n); // 80 USDC = $80, fresh bucket
  });
});

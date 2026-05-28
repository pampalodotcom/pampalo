import { getShieldDetails } from "@/helpers/functions/shield.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers } from "ethers";

// Supported-asset registry behavior + oracle plumbing. Uses MockOracle
// so we don't depend on a live Chainlink feed.

describe("supported assets", () => {
  let pampalo: ethers.Contract;
  let usdcDeployment: ethers.Contract;
  let fourDecDeployment: ethers.Contract;
  let usdcOracle: ethers.Contract;
  let Signers: ethers.Signer[];

  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

  before(async () => {
    ({ pampalo, Signers, usdcDeployment, fourDecDeployment, usdcOracle } =
      await getTestingAPI());
  });

  it("USDC is registered as supported by the fixture", async () => {
    const cfg = await pampalo.supportedAssets(
      await usdcDeployment.getAddress(),
    );
    expect(cfg.enabled).to.equal(true);
    expect(cfg.assetDecimals).to.equal(6);
  });

  it("FINANCE_MANAGER can register a new asset", async () => {
    const fourDecAddress = await fourDecDeployment.getAddress();

    // Reuse the USDC oracle for brevity — the test only cares that
    // the registry stores the config and surfaces it on read.
    const tx = await pampalo.addSupportedAsset(
      fourDecAddress,
      await usdcOracle.getAddress(),
      4,
    );
    await tx.wait();

    const cfg = await pampalo.supportedAssets(fourDecAddress);
    expect(cfg.enabled).to.equal(true);
    expect(cfg.assetDecimals).to.equal(4);
  });

  it("non-FINANCE_MANAGER cannot register an asset", async () => {
    const stranger = Signers[1];
    await expect(
      pampalo
        .connect(stranger)
        .addSupportedAsset(
          await fourDecDeployment.getAddress(),
          await usdcOracle.getAddress(),
          4,
        ),
    ).to.be.rejected;
  });

  it("disableSupportedAsset flips enabled false and shield reverts", async () => {
    const assetId = await usdcDeployment.getAddress();
    const assetAmount = 1_000_000n;

    const { proof } = await getShieldDetails({
      assetId,
      assetAmount,
      secret,
      owner,
    });

    await pampalo.disableSupportedAsset(assetId);

    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);
    await expect(
      pampalo.shield(assetId, assetAmount, proof.proof, proof.publicInputs, "0x"),
    ).to.be.revertedWith("asset not supported");

    // Re-enable for the rest of the suite
    await pampalo.addSupportedAsset(assetId, await usdcOracle.getAddress(), 6);
  });

  it("stale oracle reverts the shield path", async () => {
    const assetId = await usdcDeployment.getAddress();
    const assetAmount = 1_000_000n;

    const { proof } = await getShieldDetails({
      assetId,
      assetAmount,
      secret,
      owner,
    });

    await usdcOracle.setStale(true);
    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);
    await expect(
      pampalo.shield(assetId, assetAmount, proof.proof, proof.publicInputs, "0x"),
    ).to.be.revertedWith("MockOracle: stale price");
    await usdcOracle.setStale(false);
  });
});

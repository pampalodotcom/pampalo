import { getShieldDetails } from "@/helpers/functions/shield.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers } from "ethers";

// shieldBudget(address) is a read-only convenience for the client
// slider. These tests just assert the returned triple agrees with the
// raw `shieldUsage` / `addressMonthlyCapUsdCents` / `defaultMonthlyCapUsdCents`
// state and with how `_bumpUsage` actually behaves.

describe("shieldBudget", () => {
  let pampalo: ethers.Contract;
  let usdcDeployment: ethers.Contract;
  let Signers: ethers.Signer[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let connection: any;

  const assetAmount = 5_000_000n; // 5 USDC
  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

  const DEFAULT_CAP = 20_000n; // 200_00 = $200 in cents

  before(async () => {
    ({ pampalo, Signers, usdcDeployment, connection } = await getTestingAPI());
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

  it("returns the default cap and zero used for an untouched address", async () => {
    const fresh = Signers[10];
    const [cap, used, remaining] = await pampalo.shieldBudget(fresh.address);
    expect(cap).to.equal(DEFAULT_CAP);
    expect(used).to.equal(0n);
    expect(remaining).to.equal(DEFAULT_CAP);
  });

  it("reflects usage after a shield", async () => {
    const user = Signers[11];

    await usdcDeployment.mint(user.address, assetAmount);
    await usdcDeployment
      .connect(user)
      .approve(await pampalo.getAddress(), assetAmount);

    const { assetId, proof } = await buildShield();
    await pampalo
      .connect(user)
      .shield(assetId, assetAmount, proof.proof, proof.publicInputs, "0x");

    // 5 USDC * 100 cents/USDC = 500 cents charged
    const [cap, used, remaining] = await pampalo.shieldBudget(user.address);
    expect(cap).to.equal(DEFAULT_CAP);
    expect(used).to.equal(500n);
    expect(remaining).to.equal(DEFAULT_CAP - 500n);
  });

  it("returns the per-address override when set, ignoring the default", async () => {
    const user = Signers[12];
    const overrideCap = 50_000n; // $500
    await pampalo.setAddressMonthlyCap(user.address, overrideCap);

    const [cap, used, remaining] = await pampalo.shieldBudget(user.address);
    expect(cap).to.equal(overrideCap);
    expect(used).to.equal(0n);
    expect(remaining).to.equal(overrideCap);
  });

  it("treats stored usage from a prior month as zero", async () => {
    const user = Signers[13];

    await usdcDeployment.mint(user.address, assetAmount);
    await usdcDeployment
      .connect(user)
      .approve(await pampalo.getAddress(), assetAmount);

    const { assetId, proof } = await buildShield();
    await pampalo
      .connect(user)
      .shield(assetId, assetAmount, proof.proof, proof.publicInputs, "0x");

    // Sanity — same-month usage is present
    const mid = await pampalo.shieldBudget(user.address);
    expect(mid[1]).to.equal(500n);

    // Jump ~32 days to guarantee crossing a UTC month boundary
    await connection.networkHelpers.time.increase(32 * 24 * 60 * 60);

    const [cap, used, remaining] = await pampalo.shieldBudget(user.address);
    expect(cap).to.equal(DEFAULT_CAP);
    expect(used).to.equal(0n);
    expect(remaining).to.equal(DEFAULT_CAP);
  });

  it("saturates remaining at zero when used has met or exceeded the cap", async () => {
    const user = Signers[14];

    // Charge to 5000 cents (50 USDC), then lower the cap below that.
    await usdcDeployment.mint(user.address, 50_000_000n);
    await usdcDeployment
      .connect(user)
      .approve(await pampalo.getAddress(), 50_000_000n);

    const { assetId, proof } = await buildShield(50_000_000n);
    await pampalo
      .connect(user)
      .shield(assetId, 50_000_000n, proof.proof, proof.publicInputs, "0x");

    // Drop this address's cap to $10 — less than the $50 already used.
    await pampalo.setAddressMonthlyCap(user.address, 1_000n);

    const [cap, used, remaining] = await pampalo.shieldBudget(user.address);
    expect(cap).to.equal(1_000n);
    expect(used).to.equal(5_000n);
    expect(remaining).to.equal(0n);
  });
});

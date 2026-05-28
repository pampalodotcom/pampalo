import { approve } from "@/helpers/functions/approve.js";
import { getShieldDetails } from "@/helpers/functions/shield.js";
import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { PoseidonMerkleTree } from "@pampalo/shared/classes/PoseidonMerkleTree";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { expect } from "chai";
import { ethers, parseEther } from "ethers";

// Exercises the full bb.js prover path for `shield` / `shieldNative`,
// driven through the queue + booth-bypass flow so the leaf actually
// makes it into the tree within the test transaction. Wait-time
// semantics are tested separately in shield-wait.test.ts.

describe("shield", () => {
  let Signers: ethers.Signer[];

  let pampalo: ethers.Contract;
  let usdcDeployment: ethers.Contract;

  let tree: PoseidonMerkleTree;

  const assetAmount = 5_000_000n; // 5 with 6 decimals
  const secret =
    2389312107716289199307843900794656424062350252250388738019021107824217896920n;
  const ownerSecret =
    10036677144260647934022413515521823129584317400947571241312859176539726523915n;
  const owner = BigInt(poseidon2Hash([ownerSecret]).toString());

  // Snapshot the next pending-shield id BEFORE shield() so we know
  // which queue slot to flush. shield() returns the id but ethers
  // tx receipts don't surface return values without parsing the
  // event log — easier to just read nextPendingId beforehand.
  const queueAndExecute = async (
    runner: ethers.Signer,
    shieldTx: () => Promise<ethers.ContractTransactionResponse>,
  ) => {
    const id = (await pampalo.nextPendingId()) as bigint;
    await (await shieldTx()).wait();
    await pampalo.connect(runner).getFunction("executeShieldImmediate")(id);
    return id;
  };

  before(async () => {
    ({ pampalo, Signers, usdcDeployment, tree } = await getTestingAPI());
  });

  it("shields an ERC-20 and the contract root matches the off-chain tree", async () => {
    const assetId = await usdcDeployment.getAddress();

    const { proof } = await getShieldDetails({
      assetId,
      assetAmount,
      secret,
      owner,
    });

    await usdcDeployment.approve(await pampalo.getAddress(), assetAmount);

    const usdcBalanceBefore = await usdcDeployment.balanceOf(
      Signers[0].address,
    );

    await queueAndExecute(Signers[0], () =>
      pampalo.shield(
        assetId,
        assetAmount,
        proof.proof,
        proof.publicInputs,
        "0x",
      ),
    );

    const usdcBalanceAfter = await usdcDeployment.balanceOf(Signers[0].address);
    expect(usdcBalanceAfter).eq(usdcBalanceBefore - assetAmount);

    await tree.insert(proof.publicInputs[0], 0);

    const contractRoot = await pampalo.currentRoot();
    expect(contractRoot).eq((await tree.getRoot()).toString());
  });

  it("shields native ETH and the contract escrows the right amount", async () => {
    const amount = parseEther("1");
    const ethAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    const { proof } = await getShieldDetails({
      assetId: ethAddress,
      assetAmount: amount,
      secret,
      owner,
    });

    const provider = Signers[0].provider!;
    const userBalanceBefore = await provider.getBalance(Signers[0].address);
    const pampaloBalanceBefore = await provider.getBalance(
      await pampalo.getAddress(),
    );

    await queueAndExecute(Signers[0], () =>
      pampalo.shieldNative(proof.proof, proof.publicInputs, "0x", {
        value: amount,
      }),
    );

    const userBalanceAfter = await provider.getBalance(Signers[0].address);
    const pampaloBalanceAfter = await provider.getBalance(
      await pampalo.getAddress(),
    );

    expect(userBalanceBefore - amount).gt(userBalanceAfter); // factors in gas
    expect(pampaloBalanceBefore + amount).eq(pampaloBalanceAfter);
  });

  it("matches the noir test vector for a second shield call", async () => {
    const assetId = await usdcDeployment.getAddress();
    const amount = 10_000_000n; // 10 with 6 decimals

    const { proof } = await getShieldDetails({
      assetId,
      assetAmount: amount,
      secret,
      owner,
    });

    await approve(
      Signers[0],
      await usdcDeployment.getAddress(),
      await pampalo.getAddress(),
      amount,
    );

    const usdcBalanceBefore = await usdcDeployment.balanceOf(
      Signers[0].address,
    );

    await queueAndExecute(Signers[0], () =>
      pampalo.shield(assetId, amount, proof.proof, proof.publicInputs, "0x"),
    );

    const usdcBalanceAfter = await usdcDeployment.balanceOf(Signers[0].address);
    expect(usdcBalanceAfter).to.equal(usdcBalanceBefore - amount);
  });
});

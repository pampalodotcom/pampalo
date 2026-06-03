import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { expect } from "chai";
import { ethers, id, ZeroAddress } from "ethers";

// Role bootstrap, grant/revoke, and AccessControlEnumerable views.
// AccessControlEnumerable is what lets the front-end render "all
// vigilant citizens" / "all finance managers" without an off-chain
// indexer — getRoleMember(role, idx) + getRoleMemberCount(role).

describe("access control", () => {
  let pampalo: ethers.Contract;
  let Signers: ethers.Signer[];

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const VIGILANT_CITIZEN_ROLE = id("VIGILANT_CITIZEN_ROLE");
  const FINANCE_MANAGER_ROLE = id("FINANCE_MANAGER_ROLE");
  const BOOTH_OPERATOR_ROLE = id("BOOTH_OPERATOR_ROLE");

  before(async () => {
    ({ pampalo, Signers } = await getTestingAPI());
  });

  it("constructor grants deployer DEFAULT_ADMIN + all three operational roles", async () => {
    const deployer = Signers[0];
    expect(
      await pampalo.hasRole(DEFAULT_ADMIN_ROLE, deployer.address),
    ).to.equal(true);
    expect(
      await pampalo.hasRole(VIGILANT_CITIZEN_ROLE, deployer.address),
    ).to.equal(true);
    expect(
      await pampalo.hasRole(FINANCE_MANAGER_ROLE, deployer.address),
    ).to.equal(true);
    expect(
      await pampalo.hasRole(BOOTH_OPERATOR_ROLE, deployer.address),
    ).to.equal(true);
  });

  it("does not grant operational roles to a fresh address by default", async () => {
    const stranger = Signers[1];
    expect(
      await pampalo.hasRole(VIGILANT_CITIZEN_ROLE, stranger.address),
    ).to.equal(false);
    expect(
      await pampalo.hasRole(FINANCE_MANAGER_ROLE, stranger.address),
    ).to.equal(false);
    expect(
      await pampalo.hasRole(BOOTH_OPERATOR_ROLE, stranger.address),
    ).to.equal(false);
  });

  it("admin can grant and revoke roles", async () => {
    const stranger = Signers[2];

    await pampalo.grantRole(VIGILANT_CITIZEN_ROLE, stranger.address);
    expect(
      await pampalo.hasRole(VIGILANT_CITIZEN_ROLE, stranger.address),
    ).to.equal(true);

    await pampalo.revokeRole(VIGILANT_CITIZEN_ROLE, stranger.address);
    expect(
      await pampalo.hasRole(VIGILANT_CITIZEN_ROLE, stranger.address),
    ).to.equal(false);
  });

  it("non-admin cannot grant roles", async () => {
    const stranger = Signers[3];
    await expect(
      pampalo
        .connect(stranger)
        .grantRole(VIGILANT_CITIZEN_ROLE, stranger.address),
    ).to.be.rejected;
  });

  it("AccessControlEnumerable enumerates role members", async () => {
    const newCitizen = Signers[4];
    await pampalo.grantRole(VIGILANT_CITIZEN_ROLE, newCitizen.address);

    const count = await pampalo.getRoleMemberCount(VIGILANT_CITIZEN_ROLE);
    expect(count).to.be.gte(2n); // deployer + newCitizen

    const members = new Set<string>();
    for (let i = 0; i < Number(count); i++) {
      members.add(
        (
          (await pampalo.getRoleMember(VIGILANT_CITIZEN_ROLE, i)) as string
        ).toLowerCase(),
      );
    }
    expect(members.has(Signers[0].address.toLowerCase())).to.equal(true);
    expect(members.has(newCitizen.address.toLowerCase())).to.equal(true);
    expect(members.has(ZeroAddress)).to.equal(false);
  });

  it("FINANCE_MANAGER-only admin functions reject non-holders", async () => {
    const stranger = Signers[5];
    await expect(pampalo.connect(stranger).setDefaultMonthlyCap(123)).to.be
      .rejected;
    await expect(pampalo.connect(stranger).weAreFull()).to.be.rejected;
    await expect(pampalo.connect(stranger).setShieldWaitTime(7200)).to.be
      .rejected;
  });
});

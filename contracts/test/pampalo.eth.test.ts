import { expect } from "chai";
import { ethers } from "ethers";
import { network } from "hardhat";

// Generated TypeChain bindings live in contracts/types/ethers-contracts,
// which is git-ignored (regenerated on every `hardhat compile`). Importing
// them is fine *inside the test suite* — never from shipped source.
import {
  PampaloDirectoryResolver__factory,
  PampaloRegistrar__factory,
} from "../types/ethers-contracts/index.js";
import type {
  PampaloDirectoryResolver,
  PampaloRegistrar,
} from "../types/ethers-contracts/index.js";

// Pampalo username registrar — exercised against a MAINNET FORK so the
// registrar runs over the *real* ENS NameWrapper + Chainlink ETH/USD feed
// (production bytecode + state), not mocks. The fork impersonates whoever
// owns pampalo.eth at the forked block — no private key ever touches this
// repo — and wraps the name in-memory if it isn't wrapped yet.
//
// Requires ALCHEMY_API_KEY (to source the fork). The rest of the suite is
// keyless, so when the key is absent this whole block is SKIPPED rather
// than failing the offline/CI run. Pin FORK_BLOCK for determinism + caching.

// ── real mainnet addresses ────────────────────────────────────────────────
const NAME_WRAPPER = "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";
const BASE_REGISTRAR = "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85";
const PUBLIC_RESOLVER = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63";
const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";

const LABEL = "pampalo";
const NAME = "pampalo.eth";

// ── registrar config under test ───────────────────────────────────────────
const PRICE_CENTS = 10_000n; // $100.00
const DISCOUNT_CENTS = 5_000n; // $50.00
const TEN_YEARS = 10n * 365n * 24n * 60n * 60n;
const MAX_FEED_AGE = 24n * 60n * 60n; // 1 day — generous on a fork

const FINANCE_MANAGER_ROLE = ethers.id("FINANCE_MANAGER_ROLE");

// 65-byte uncompressed secp256k1 pubkey shape (0x04 || X || Y) + a 32-byte id.
const ENVELOPE_KEY = "0x04" + "11".repeat(64);
const POSEIDON_ID = ethers.id("alice-poseidon-identifier");

const NAME_WRAPPER_ABI = [
  "function ownerOf(uint256 id) view returns (address)",
  "function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)",
  "function setApprovalForAll(address operator, bool approved)",
  "function wrapETH2LD(string label, address wrappedOwner, uint16 ownerControlledFuses, address resolver) returns (uint64)",
];
const BASE_REGISTRAR_ABI = [
  "function ownerOf(uint256 id) view returns (address)",
  "function setApprovalForAll(address operator, bool approved)",
];

const HAS_KEY = Boolean(process.env.ALCHEMY_API_KEY);
const forkDescribe = HAS_KEY ? describe : describe.skip;

forkDescribe("pampalo.eth username registrar (mainnet fork)", function () {
  this.timeout(180_000);

  const parentNode = ethers.namehash(NAME);
  const parentId = BigInt(parentNode);

  // Derive the hardhat-ethers helpers + provider straight off network.connect
  // so they stay correct without an `any` (getSigners/getContractFactory/…).
  type ForkConnection = Awaited<ReturnType<typeof network.connect>>;
  let hh: ForkConnection["ethers"];
  let provider: ForkConnection["provider"];

  // Read-only handle to the real NameWrapper (hand-written ABI subset). Owner-
  // signed writes go through `nameWrapperAsOwner`, built once we know who
  // controls pampalo.eth at the forked block.
  let nameWrapper: ethers.Contract;
  let nameWrapperAsOwner: ethers.Contract;

  let deployer: ethers.Signer; // signers[0] — deploys the registrar/resolver
  let ownerSigner: ethers.Signer; // impersonated pampalo.eth owner
  let safe: ethers.Signer;
  let finance: ethers.Signer;
  let treasury: ethers.Signer;
  let buyer: ethers.Signer;
  let allowlisted: ethers.Signer;
  let stranger: ethers.Signer;

  let registrar: PampaloRegistrar;
  let resolver: PampaloDirectoryResolver;

  // Fork + wrap pampalo.eth once; it's the expensive part.
  before(async () => {
    const connection = await network.connect("mainnetFork");
    hh = connection.ethers;
    provider = connection.provider;

    const signers = await hh.getSigners();
    [deployer, safe, finance, treasury, buyer, allowlisted, stranger] = signers;

    nameWrapper = new ethers.Contract(NAME_WRAPPER, NAME_WRAPPER_ABI, hh.provider);
    const baseRegistrar = new ethers.Contract(
      BASE_REGISTRAR,
      BASE_REGISTRAR_ABI,
      hh.provider,
    );

    // Who controls pampalo.eth at this block? If wrapped, the NameWrapper
    // ERC-1155 holder; else the BaseRegistrar (ERC-721) registrant.
    const wrappedOwner: string = await nameWrapper.ownerOf(parentId);
    const isWrapped = wrappedOwner !== ethers.ZeroAddress;
    const ownerAddr = isWrapped
      ? wrappedOwner
      : await baseRegistrar.ownerOf(BigInt(ethers.id(LABEL)));

    await provider.request({
      method: "hardhat_impersonateAccount",
      params: [ownerAddr],
    });
    await provider.request({
      method: "hardhat_setBalance",
      params: [ownerAddr, ethers.toBeHex(ethers.parseEther("100"))],
    });
    ownerSigner = await hh.getSigner(ownerAddr);

    // `Contract.connect(signer)` is typed to return a method-less BaseContract,
    // so bind the signer at construction for the owner-signed writes instead.
    nameWrapperAsOwner = new ethers.Contract(
      NAME_WRAPPER,
      NAME_WRAPPER_ABI,
      ownerSigner,
    );

    if (!isWrapped) {
      // Approve the NameWrapper to take the .eth ERC-721, then wrap it →
      // pampalo.eth becomes an ERC-1155 owned by the same wallet.
      const baseRegistrarAsOwner = new ethers.Contract(
        BASE_REGISTRAR,
        BASE_REGISTRAR_ABI,
        ownerSigner,
      );
      await (
        await baseRegistrarAsOwner.setApprovalForAll(NAME_WRAPPER, true)
      ).wait();
      await (
        await nameWrapperAsOwner.wrapETH2LD(LABEL, ownerAddr, 0, PUBLIC_RESOLVER)
      ).wait();
    }
  });

  // Fresh registrar + resolver per test; re-approve it on the wrapped parent.
  beforeEach(async () => {
    registrar = await new PampaloRegistrar__factory(deployer).deploy(
      NAME_WRAPPER,
      parentNode,
      ETH_USD_FEED,
      MAX_FEED_AGE,
      ethers.ZeroAddress, // resolver set after we deploy it (breaks the cycle)
      await treasury.getAddress(),
      await safe.getAddress(),
      PRICE_CENTS,
      DISCOUNT_CENTS,
      TEN_YEARS,
    );
    await registrar.waitForDeployment();

    resolver = await new PampaloDirectoryResolver__factory(deployer).deploy(
      NAME_WRAPPER,
      await registrar.getAddress(),
    );
    await resolver.waitForDeployment();

    await (
      await registrar.connect(safe).setResolver(await resolver.getAddress())
    ).wait();
    await (
      await registrar.connect(safe).grantRole(
        FINANCE_MANAGER_ROLE,
        await finance.getAddress(),
      )
    ).wait();

    // Let the registrar mint subnames under the wrapped parent.
    await (
      await nameWrapperAsOwner.setApprovalForAll(
        await registrar.getAddress(),
        true,
      )
    ).wait();
  });

  it("registers a username that resolves to envelope key + poseidon id", async () => {
    const due = await registrar.priceWei();
    expect(due).to.be.greaterThan(0n);

    await (
      await registrar
        .connect(buyer)
        .register("alice", ENVELOPE_KEY, POSEIDON_ID, [], { value: due })
    ).wait();

    const node = await registrar.nodeOf("alice");
    expect(await nameWrapper.ownerOf(BigInt(node))).to.equal(
      await buyer.getAddress(),
    );

    const [env, pos] = await resolver.resolvePampalo(node);
    expect(env).to.equal(ENVELOPE_KEY);
    expect(pos).to.equal(POSEIDON_ID);
  });

  it("charges exactly the USD-quoted ETH and refunds overpayment", async () => {
    const due = await registrar.priceWei();
    const before = await hh.provider.getBalance(await treasury.getAddress());

    await (
      await registrar
        .connect(buyer)
        .register("bob", ENVELOPE_KEY, POSEIDON_ID, [], {
          value: due + ethers.parseEther("0.05"),
        })
    ).wait();

    const after = await hh.provider.getBalance(await treasury.getAddress());
    expect(after - before).to.equal(due); // surplus refunded, not kept
  });

  it("reverts when underpaid", async () => {
    const due = await registrar.priceWei();
    await expect(
      registrar
        .connect(buyer)
        .register("carol", ENVELOPE_KEY, POSEIDON_ID, [], { value: due - 1n }),
    ).to.be.rejected;
  });

  it("reverts on an already-taken label", async () => {
    const due = await registrar.priceWei();
    await (
      await registrar
        .connect(buyer)
        .register("dup", ENVELOPE_KEY, POSEIDON_ID, [], { value: due })
    ).wait();

    await expect(
      registrar
        .connect(stranger)
        .register("dup", ENVELOPE_KEY, POSEIDON_ID, [], { value: due }),
    ).to.be.rejected;
  });

  it("caps child expiry at the parent's expiry", async () => {
    const due = await registrar.priceWei();
    const tx = await registrar
      .connect(buyer)
      .register("expiry", ENVELOPE_KEY, POSEIDON_ID, [], { value: due });
    const receipt = await tx.wait();
    if (!receipt) throw new Error("register tx was not mined");
    const block = await hh.provider.getBlock(receipt.blockNumber);
    if (!block) throw new Error(`block ${receipt.blockNumber} not found`);
    const mintedAt = BigInt(block.timestamp);

    const [, , parentExpiry] = await nameWrapper.getData(parentId);
    const want = mintedAt + TEN_YEARS;
    const expected = want < parentExpiry ? want : parentExpiry;

    const node = await registrar.nodeOf("expiry");
    const [, , childExpiry] = await nameWrapper.getData(BigInt(node));
    expect(childExpiry).to.equal(expected);
  });

  it("lets the current owner rotate records, rejects non-owners", async () => {
    const due = await registrar.priceWei();
    await (
      await registrar
        .connect(buyer)
        .register("rotate", ENVELOPE_KEY, POSEIDON_ID, [], { value: due })
    ).wait();
    const node = await registrar.nodeOf("rotate");

    const newKey = "0x04" + "22".repeat(64);
    const newId = ethers.id("rotated-poseidon");
    await (
      await resolver.connect(buyer).setRecords(node, newKey, newId)
    ).wait();
    const [env, pos] = await resolver.resolvePampalo(node);
    expect(env).to.equal(newKey);
    expect(pos).to.equal(newId);

    await expect(
      resolver.connect(stranger).setRecords(node, ENVELOPE_KEY, POSEIDON_ID),
    ).to.be.rejected;
  });

  it("honours the address-allowlist discount root", async () => {
    // Single-leaf tree: root = leaf, proof = []. OZ StandardMerkleTree leaf
    // encoding = keccak256(keccak256(abi.encode(address))).
    const inner = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [await allowlisted.getAddress()],
      ),
    );
    const leaf = ethers.keccak256(inner);
    await (await registrar.connect(finance).setDiscountRoot(leaf)).wait();

    const discountDue = await registrar.discountWei();
    const fullDue = await registrar.priceWei();
    expect(discountDue).to.be.lessThan(fullDue);

    const before = await hh.provider.getBalance(await treasury.getAddress());
    await (
      await registrar
        .connect(allowlisted)
        .register("vip", ENVELOPE_KEY, POSEIDON_ID, [], { value: discountDue })
    ).wait();
    const after = await hh.provider.getBalance(await treasury.getAddress());
    expect(after - before).to.equal(discountDue);

    // A non-allowlisted buyer can't pay the discounted price.
    await expect(
      registrar
        .connect(stranger)
        .register("notvip", ENVELOPE_KEY, POSEIDON_ID, [], {
          value: discountDue,
        }),
    ).to.be.rejected;
  });

  it("gates finance + admin functions by role", async () => {
    await (
      await registrar.connect(finance).setPrices(20_000n, 10_000n)
    ).wait();
    expect(await registrar.priceUsdCents()).to.equal(20_000n);

    await expect(registrar.connect(stranger).setPrices(1n, 1n)).to.be.rejected;
    await expect(
      registrar.connect(stranger).setTreasury(await stranger.getAddress()),
    ).to.be.rejected;

    await (
      await registrar.connect(safe).setTreasury(await buyer.getAddress())
    ).wait();
    expect(await registrar.treasury()).to.equal(await buyer.getAddress());
  });
});

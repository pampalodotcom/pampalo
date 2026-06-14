import { ethers } from "ethers";
import hre from "hardhat";
import { expect } from "chai";
import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { encodeV3Path, encodeV4Route } from "@/helpers/functions/swap.js";
import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// Forked-liquidity tests: drive PampaloSwapV3 / PampaloSwapV4's
// `_executeSwap` against REAL mainnet Uniswap liquidity (v3 SwapRouter02
// and the v4 singleton PoolManager). A MockSwapVerifier lets us hand-
// build public inputs; the swap LEG is the real thing, so this is what
// validates the v4 unlock/settle/take flow and the v3 exactInput path
// end-to-end. Needs ALCHEMY_API_KEY (mainnetFork RPC) — skipped without.

type Venue = "v3" | "v4";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // 6 dec
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"; // 18 dec
const V3_ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45"; // SwapRouter02
const V4_POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const POOL_FEE = 500; // 0.05% USDC/WETH
const V4_TICK_SPACING = 10;

const INPUT_AMOUNT = 1_000_000_000n; // 1,000 USDC
const FUND_USDC = 10_000_000_000n; // 10,000 USDC seeded into the pool

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

const toBytes32 = (v: bigint | string): string =>
  ethers.zeroPadValue(ethers.toBeHex(BigInt(v)), 32);
const addrToBytes32 = (a: string): string => ethers.zeroPadValue(a, 32);

describe("private swap (forked Uniswap liquidity)", function () {
  this.timeout(180_000);

  before(function () {
    if (!process.env.ALCHEMY_API_KEY) this.skip();
  });

  for (const venue of ["v3", "v4"] as Venue[]) {
    describe(venue, () => {
      let connection: Awaited<ReturnType<typeof hre.network.connect>>;
      let Signers: ethers.Signer[];
      let pampalo: ethers.Contract;
      let usdc: ethers.Contract;
      let weth: ethers.Contract;
      const venueAddr = venue === "v3" ? V3_ROUTER : V4_POOL_MANAGER;

      beforeEach(async () => {
        connection = await hre.network.connect("mainnetFork");
        Signers = await connection.ethers.getSigners();

        const VerifierFactory =
          await connection.ethers.getContractFactory("MockSwapVerifier");
        const swapVerifier =
          (await VerifierFactory.deploy()) as unknown as ethers.Contract;
        await swapVerifier.waitForDeployment();

        const name =
          venue === "v3" ? "PampaloSwapV3Harness" : "PampaloSwapV4Harness";
        const z = ethers.ZeroAddress;
        pampalo = (await (
          await connection.ethers.getContractFactory(name)
        ).deploy(
          z,
          z,
          z,
          z,
          venueAddr,
          await swapVerifier.getAddress(),
        )) as unknown as ethers.Contract;
        await pampalo.waitForDeployment();

        const poseidon = await new ethers.ContractFactory(
          [],
          Poseidon2HuffJson.bytecode,
          Signers[0],
        ).deploy();
        await poseidon.waitForDeployment();
        await pampalo.setPoseidon(await poseidon.getAddress());

        // Seed the contract's pooled USDC by overwriting its balanceOf
        // slot (USDC's balances mapping is at storage slot 9).
        const pampaloAddr = await pampalo.getAddress();
        const slot = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256"],
            [pampaloAddr, 9],
          ),
        );
        await connection.provider.send("hardhat_setStorageAt", [
          USDC,
          slot,
          toBytes32(FUND_USDC),
        ]);

        usdc = new ethers.Contract(USDC, ERC20_ABI, Signers[0]);
        weth = new ethers.Contract(WETH, ERC20_ABI, Signers[0]);
        expect(await usdc.balanceOf(pampaloAddr)).to.equal(FUND_USDC);
      });

      const buildRoute = (): string =>
        venue === "v3"
          ? encodeV3Path([USDC, WETH], [POOL_FEE])
          : encodeV4Route([
              {
                key: {
                  currency0: USDC, // USDC < WETH → currency0
                  currency1: WETH,
                  fee: POOL_FEE,
                  tickSpacing: V4_TICK_SPACING,
                  hooks: ethers.ZeroAddress,
                },
                zeroForOne: true, // sell USDC for WETH
              },
            ]);

      const buildInputs = async (target: bigint, nullifierSeed = 1n) => {
        const root = await pampalo.currentRoot();
        const nullifier = toBytes32(0xabcdef0000n + nullifierSeed);
        const bOut = await getNoteHash(1n, 2n, BigInt(WETH), target);
        return [
          toBytes32(root),
          nullifier,
          toBytes32(0n),
          toBytes32(0n),
          toBytes32(bOut),
          toBytes32(0n),
          toBytes32(0n),
          addrToBytes32(USDC),
          toBytes32(INPUT_AMOUNT),
          addrToBytes32(WETH),
          toBytes32(target),
        ];
      };

      it("swaps pooled USDC -> WETH against real liquidity", async () => {
        const pampaloAddr = await pampalo.getAddress();
        // T = 1 wei of WETH: a trivially-satisfiable floor so the real
        // price fills it; we then assert realized >> T.
        const inputs = await buildInputs(1n);
        const route = buildRoute();

        const wethBefore: bigint = await weth.balanceOf(pampaloAddr);

        await expect(pampalo.privateSwap("0x", inputs, route, [])).to.emit(
          pampalo,
          "PrivateSwapExecuted",
        );

        // Exact-input: USDC down by exactly INPUT_AMOUNT.
        expect(await usdc.balanceOf(pampaloAddr)).to.equal(
          FUND_USDC - INPUT_AMOUNT,
        );
        // Real WETH received; well above the 1-wei floor.
        const realized = (await weth.balanceOf(pampaloAddr)) - wethBefore;
        expect(realized > 10n ** 14n).to.equal(true); // > 0.0001 WETH
      });

      it("reverts when T is above the realized output", async () => {
        // 1,000 WETH out of 1,000 USDC is impossible → floor revert.
        const inputs = await buildInputs(1000n * 10n ** 18n, 2n);
        const route = buildRoute();
        const reason =
          venue === "v3" ? "Too little received" : "slippage / sandwich floor";
        await expect(
          pampalo.privateSwap("0x", inputs, route, []),
        ).to.be.revertedWith(reason);
      });
    });
  }
});

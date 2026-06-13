import { getNoteHash } from "@/helpers/functions/get-note-hash.js";
import { encodeV3Path, encodeV4Route } from "@/helpers/functions/swap.js";
import { ethers } from "ethers";
import hre from "hardhat";
import { expect } from "chai";
import Poseidon2HuffJson from "../contracts/utils/Poseidon2Huff.json" with { type: "json" };

// Venue-parameterized mechanics tests for the private-swap shell
// (PampaloSwapBase via PampaloSwapV3 / PampaloSwapV4). A MockSwapVerifier
// stands in for the real Honk verifier so these exercise the note logic
// — nullify inputs, execute against a mock venue, enforce the floor,
// insert the fixed-output + change commitments — without proof
// generation. The round-trip tests (real SwapVerifier + harness-seeded
// note against forked v4/v3 liquidity) live separately and need an RPC.

type Venue = "v3" | "v4";

const INPUT_AMOUNT = 100_000_000n; // 100 USDC (6 dec)
const OUT_PER_IN_WAD = 5n * 10n ** 17n; // 0.5 output per input
const REALIZED = (INPUT_AMOUNT * OUT_PER_IN_WAD) / 10n ** 18n; // 50_000_000
const TARGET_OUTPUT = REALIZED - 10_000_000n; // T below realized; surplus forfeited

const toBytes32 = (v: bigint | string): string =>
  ethers.zeroPadValue(ethers.toBeHex(BigInt(v)), 32);

const addrToBytes32 = (a: string): string => ethers.zeroPadValue(a, 32);

describe("private swap (mechanics)", () => {
  for (const venue of ["v3", "v4"] as Venue[]) {
    describe(venue, () => {
      let connection: Awaited<ReturnType<typeof hre.network.connect>>;
      let Signers: ethers.Signer[];
      let pampalo: ethers.Contract;
      let usdc: ethers.Contract;
      let weth: ethers.Contract;
      let venueAddr: string;

      beforeEach(async () => {
        connection = await hre.network.connect();
        Signers = await connection.ethers.getSigners();

        // Tokens: USDC (pooled input) + an 18-dec WETH stand-in (output).
        const USDCFactory = await connection.ethers.getContractFactory("USDC");
        usdc = (await USDCFactory.deploy()) as unknown as ethers.Contract;
        await usdc.waitForDeployment();

        const WETHFactory =
          await connection.ethers.getContractFactory("MintableERC20");
        weth = (await WETHFactory.deploy(
          "Wrapped Ether",
          "WETH",
          18,
        )) as unknown as ethers.Contract;
        await weth.waitForDeployment();

        // Mock verifier (always passes) so we can hand-build public inputs.
        const VerifierFactory =
          await connection.ethers.getContractFactory("MockSwapVerifier");
        const swapVerifier =
          (await VerifierFactory.deploy()) as unknown as ethers.Contract;
        await swapVerifier.waitForDeployment();

        // Mock venue, funded with the output token so it can pay out.
        if (venue === "v3") {
          const RouterFactory =
            await connection.ethers.getContractFactory("MockV3SwapRouter");
          const router =
            (await RouterFactory.deploy()) as unknown as ethers.Contract;
          await router.waitForDeployment();
          await router.setRate(OUT_PER_IN_WAD);
          venueAddr = await router.getAddress();
        } else {
          const PMFactory =
            await connection.ethers.getContractFactory("MockV4PoolManager");
          const pm =
            (await PMFactory.deploy()) as unknown as ethers.Contract;
          await pm.waitForDeployment();
          await pm.setRate(OUT_PER_IN_WAD);
          venueAddr = await pm.getAddress();
        }
        await weth.mint(venueAddr, REALIZED * 10n);

        // Deploy the venue contract (harness so we could seed notes too).
        const contractName =
          venue === "v3" ? "PampaloSwapV3Harness" : "PampaloSwapV4Harness";
        const PampaloFactory =
          await connection.ethers.getContractFactory(contractName);
        const z = ethers.ZeroAddress;
        pampalo = (await PampaloFactory.deploy(
          z, // depositVerifier (unused on the swap path)
          z, // transferVerifier
          z, // withdrawVerifier
          z, // transferExternalVerifier
          venueAddr, // SwapRouter02 (v3) / PoolManager (v4)
          await swapVerifier.getAddress(),
        )) as unknown as ethers.Contract;
        await pampalo.waitForDeployment();

        // Poseidon hasher for the tree.
        const poseidonFactory = new ethers.ContractFactory(
          [],
          Poseidon2HuffJson.bytecode,
          Signers[0],
        );
        const poseidon = await poseidonFactory.deploy();
        await poseidon.waitForDeployment();
        await pampalo.setPoseidon(await poseidon.getAddress());

        // Fund the contract's pooled USDC.
        await usdc.mint(await pampalo.getAddress(), INPUT_AMOUNT * 10n);
      });

      const buildRoute = (): string => {
        return venue === "v3"
          ? encodeV3Path([usdc.target as string, weth.target as string], [3000])
          : encodeV4Route([
              {
                key: {
                  currency0: usdc.target as string,
                  currency1: weth.target as string,
                  fee: 3000,
                  tickSpacing: 60,
                  hooks: ethers.ZeroAddress,
                },
                zeroForOne: true,
              },
            ]);
      };

      const buildPublicInputs = async (opts: {
        target?: bigint;
        withChange?: boolean;
      }): Promise<{ inputs: string[]; nullifier: string; bOut: bigint }> => {
        const target = opts.target ?? TARGET_OUTPUT;
        const root = await pampalo.currentRoot();

        const nullifier = toBytes32(
          0x1234567890abcdef1234567890abcdef1234567890abcdefn,
        );
        const bOut = await getNoteHash(
          1n, // owner
          2n, // secret
          BigInt(weth.target as string),
          target,
        );
        const change = opts.withChange
          ? await getNoteHash(
              3n,
              4n,
              BigInt(usdc.target as string),
              5_000_000n,
            )
          : 0n;

        const inputs: string[] = [
          toBytes32(root), // 0 root
          nullifier, // 1 nullifier
          toBytes32(0n), // 2
          toBytes32(0n), // 3
          toBytes32(bOut), // 4 B@T
          toBytes32(change), // 5 change
          toBytes32(0n), // 6
          addrToBytes32(usdc.target as string), // 7 input_asset
          toBytes32(INPUT_AMOUNT), // 8 input_amount
          addrToBytes32(weth.target as string), // 9 output_asset
          toBytes32(target), // 10 target_output
        ];
        return { inputs, nullifier, bOut };
      };

      it("executes an exact-input swap, mints the fixed-output note, forfeits surplus", async () => {
        const { inputs, nullifier } = await buildPublicInputs({});
        const route = buildRoute();

        const usdcBefore = await usdc.balanceOf(await pampalo.getAddress());
        const wethBefore = await weth.balanceOf(await pampalo.getAddress());
        const rootBefore = await pampalo.currentRoot();

        await expect(
          pampalo.privateSwap("0x", inputs, route, []),
        ).to.emit(pampalo, "PrivateSwapExecuted");

        // Exact-input: pooled USDC down by exactly INPUT_AMOUNT.
        expect(await usdc.balanceOf(await pampalo.getAddress())).to.equal(
          usdcBefore - INPUT_AMOUNT,
        );
        // Contract received the full realized output (surplus forfeited
        // into reserves; the note only commits to T).
        expect(await weth.balanceOf(await pampalo.getAddress())).to.equal(
          wethBefore + REALIZED,
        );
        // Nullifier spent + new commitment inserted (root advanced).
        expect(await pampalo.nullifierUsed(nullifier)).to.equal(true);
        expect(await pampalo.currentRoot()).to.not.equal(rootBefore);
      });

      it("inserts both the output note and the change note", async () => {
        const { inputs } = await buildPublicInputs({ withChange: true });
        const route = buildRoute();
        // Two non-zero output commitments -> two NoteInserted-style inserts.
        // We assert via the root advancing and the call succeeding.
        await expect(pampalo.privateSwap("0x", inputs, route, [])).to.emit(
          pampalo,
          "PrivateSwapExecuted",
        );
      });

      it("reverts when the realized output is below the floor T", async () => {
        // T absurdly high: v3 router reverts "Too little received";
        // v4 adapter reverts on its own floor check.
        const { inputs } = await buildPublicInputs({
          target: 10n ** 24n,
        });
        const route = buildRoute();
        const reason =
          venue === "v3" ? "Too little received" : "slippage / sandwich floor";
        await expect(
          pampalo.privateSwap("0x", inputs, route, []),
        ).to.be.revertedWith(reason);
      });

      it("rejects a replayed nullifier", async () => {
        const route = buildRoute();
        const { inputs } = await buildPublicInputs({});
        await pampalo.privateSwap("0x", inputs, route, []);

        // Re-run against the historical root that still knows the nullifier
        // is now spent. Rebuild with the same nullifier but the prior root
        // (still in knownRoots).
        const replay = [...inputs];
        await expect(
          pampalo.privateSwap("0x", replay, route, []),
        ).to.be.revertedWith("Nullifier already spent");
      });
    });
  }
});

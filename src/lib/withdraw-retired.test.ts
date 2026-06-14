/// <reference types="vite/client" />
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";
import { prepareUnshield } from "./unshield-prep";
import {
  prepareRetiredWithdrawal,
  resolveRetiredLeafIndex,
} from "./withdraw-retired";

// Mock the heavy proof builder — we assert WHAT prepareRetiredWithdrawal hands
// it (the ADR-0022 invariants), not the bb.js proof itself. `vi.mock` is
// hoisted above these imports by vitest, so the mock is registered first.
vi.mock("./unshield-prep", () => ({
  prepareUnshield: vi.fn(),
}));

const mockPrepare = vi.mocked(prepareUnshield);
const fakeTree = {} as unknown as PoseidonMerkleTreeType;

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const OWNER = "0x" + "11".repeat(32);
const SECRET = "0x" + "22".repeat(32);
const COMMITMENT = "0x" + "ab".repeat(32);
const OLD_PAMPALO = "0x3e6dfc4c233486a44e26a548e191c839f069037f";
const EVM = "0x405338f496d665c821518107895f0b9639fde789";

describe("resolveRetiredLeafIndex", () => {
  test("prefers the note's own stored leafIndex", () => {
    const idx = resolveRetiredLeafIndex(
      { leafCommitment: COMMITMENT, leafIndex: 7 },
      new Map([[COMMITMENT, 99]]),
    );
    expect(idx).toBe(7);
  });

  test("falls back to the tree map (fresh-device note), case-insensitive", () => {
    const idx = resolveRetiredLeafIndex(
      { leafCommitment: COMMITMENT.toUpperCase() },
      new Map([[COMMITMENT, 42]]),
    );
    expect(idx).toBe(42);
  });

  test("throws when the leaf isn't in the archived snapshot", () => {
    expect(() =>
      resolveRetiredLeafIndex({ leafCommitment: COMMITMENT }, new Map()),
    ).toThrow(/cannot withdraw/);
  });
});

describe("prepareRetiredWithdrawal", () => {
  beforeEach(() => {
    mockPrepare.mockReset();
    mockPrepare.mockResolvedValue(
      {} as Awaited<ReturnType<typeof prepareUnshield>>,
    );
  });

  test("exits the FULL note amount (no change) against the OLD contract", async () => {
    await prepareRetiredWithdrawal({
      chainId: 84532,
      oldPampalo: OLD_PAMPALO,
      note: {
        asset: ETH,
        amount: "1000",
        secret: SECRET,
        owner: OWNER,
        leafCommitment: COMMITMENT,
        leafIndex: 3,
      },
      tree: fakeTree,
      commitmentToLeafIndex: new Map(),
      exitAddress: EVM,
      walletPrivateKey: "0x" + "33".repeat(32),
      selfPoseidon: OWNER,
      selfEnvelopePubKey: "0x04" + "44".repeat(64),
    });

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    const arg = mockPrepare.mock.calls[0][0];
    expect(arg.pampaloAddress).toBe(OLD_PAMPALO); // old contract, not active
    expect(arg.exitAddress).toBe(EVM);
    expect(arg.exitAmount).toBe(1000n); // full amount
    expect(arg.inputNote.amount).toBe(1000n);
    expect(arg.exitAmount).toBe(arg.inputNote.amount); // ⇒ no change output
    expect(arg.inputNote.leafIndex).toBe(3);
    expect(arg.tree).toBe(fakeTree);
  });

  test("recovers leafIndex from the tree map when the note lacks one", async () => {
    await prepareRetiredWithdrawal({
      chainId: 84532,
      oldPampalo: OLD_PAMPALO,
      note: {
        asset: ETH,
        amount: "500",
        secret: SECRET,
        owner: OWNER,
        leafCommitment: COMMITMENT,
        // no leafIndex (fresh-device note)
      },
      tree: fakeTree,
      commitmentToLeafIndex: new Map([[COMMITMENT, 17]]),
      exitAddress: EVM,
      walletPrivateKey: "0x" + "33".repeat(32),
      selfPoseidon: OWNER,
      selfEnvelopePubKey: "0x04" + "44".repeat(64),
    });

    expect(mockPrepare.mock.calls[0][0].inputNote.leafIndex).toBe(17);
  });

  test("propagates the leaf-not-found error before proving", async () => {
    await expect(
      prepareRetiredWithdrawal({
        chainId: 84532,
        oldPampalo: OLD_PAMPALO,
        note: {
          asset: ETH,
          amount: "500",
          secret: SECRET,
          owner: OWNER,
          leafCommitment: COMMITMENT,
        },
        tree: fakeTree,
        commitmentToLeafIndex: new Map(), // empty → unrecoverable
        exitAddress: EVM,
        walletPrivateKey: "0x" + "33".repeat(32),
        selfPoseidon: OWNER,
        selfEnvelopePubKey: "0x04" + "44".repeat(64),
      }),
    ).rejects.toThrow(/cannot withdraw/);
    expect(mockPrepare).not.toHaveBeenCalled();
  });
});

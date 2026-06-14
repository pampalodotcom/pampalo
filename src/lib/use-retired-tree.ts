import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";

// ADR 0022 — rebuilds the merkle tree of a RETIRED (redeployed-away) Pampalo
// deployment, for the "Withdraw to wallet" path. Mirrors `useMerkleTree`, but
// sources leaves from `shieldQueue.store.listArchivedLeaves` (the snapshot
// taken at cutover) instead of the live `leavesForChain` — the old leaves were
// wiped from `pampaloLeaves` (ADR 0017) and can't stay there (the reused
// per-chain deployment row would make the new tree collide).
//
// The full snapshot's root equals the old contract's final root, which is in
// its `isKnownRoot` window, so a Withdraw proof against it verifies. Also
// returns a `commitment → leafIndex` map so a retired note rebuilt on a fresh
// device (from the archived ciphertexts, which carry no leafIndex) can recover
// its position.

const TREE_HEIGHT = 12; // matches pum_lib's HEIGHT and the on-chain TREE_HEIGHT

export type RetiredTreeState = {
  /** Populated once the archived leaves resolve and the tree is built.
   *  null while loading or when `enabled` is false. */
  tree: PoseidonMerkleTreeType | null;
  /** Lowercased `leafCommitment` → absolute `leafIndex` for every leaf in
   *  the old tree. Empty until built. */
  commitmentToLeafIndex: Map<string, number>;
  /** True while the archived-leaf query is in flight or the tree is building. */
  isLoading: boolean;
  /** Count of inserted leaves. */
  leafCount: number;
};

const EMPTY_MAP = new Map<string, number>();

export function useRetiredTree(
  chainId: number | null,
  pampalo: string | null,
  enabled: boolean,
): RetiredTreeState {
  const rows = useQuery(
    api.shieldQueue.store.listArchivedLeaves,
    enabled && chainId !== null && pampalo
      ? { chainId, pampalo }
      : "skip",
  );

  const [tree, setTree] = useState<PoseidonMerkleTreeType | null>(null);
  const [map, setMap] = useState<Map<string, number>>(EMPTY_MAP);
  const [leafCount, setLeafCount] = useState(0);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (!enabled || rows === undefined) {
      setTree(null);
      setMap(EMPTY_MAP);
      setLeafCount(0);
      return;
    }
    // Mutable holder (not a bare `let`) so eslint's no-unnecessary-condition
    // doesn't treat the cleanup-mutated flag as a constant.
    const run = { cancelled: false };
    setBuilding(true);
    void (async () => {
      try {
        const mod = await import("@pampalo/shared/classes/PoseidonMerkleTree");
        const next = new mod.PoseidonMerkleTree(TREE_HEIGHT);
        await Promise.resolve();
        const nextMap = new Map<string, number>();
        for (const row of rows) {
          await next.insert(BigInt(row.leafCommitment), row.leafIndex);
          nextMap.set(row.leafCommitment.toLowerCase(), row.leafIndex);
        }
        if (run.cancelled) return;
        setTree(next);
        setMap(nextMap);
        setLeafCount(rows.length);
      } finally {
        if (!run.cancelled) setBuilding(false);
      }
    })();
    return () => {
      run.cancelled = true;
    };
  }, [enabled, rows]);

  return {
    tree,
    commitmentToLeafIndex: map,
    isLoading: enabled && (rows === undefined || building),
    leafCount,
  };
}

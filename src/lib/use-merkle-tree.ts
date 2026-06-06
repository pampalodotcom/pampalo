import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { PoseidonMerkleTree as PoseidonMerkleTreeType } from "@pampalo/shared/classes/PoseidonMerkleTree";

// Builds the wallet's local mirror of the on-chain Pampalo merkle tree
// by subscribing to `shieldQueue.store.leavesForChain` and inserting
// each `(epoch, leafIndex, leafValue)` row into a fresh
// `PoseidonMerkleTree`. The result is the tree object the transfer /
// unshield proof generators expect — `tree.getRoot()` and
// `tree.getProof(leafIndex)` are the only methods callers use.
//
// Scope:
//   - Single epoch (v1). The hook walks every row returned by the
//     query and inserts at its absolute `leafIndex`; when epoch
//     rollover lands (TRANSFERS.md §11) this grows an epoch param.
//   - Lazy: pass `enabled = false` from the consumer until the user
//     actually opens the transfer compose surface. The
//     PoseidonMerkleTree module isn't tiny.
//   - Reactive: the underlying useQuery re-fires when a new
//     LeafInserted lands; the tree rebuilds and the proof-gen path
//     picks up the new root automatically.

const TREE_HEIGHT = 12; // matches pum_lib's HEIGHT and the on-chain TREE_HEIGHT

export type MerkleTreeState = {
  /** Populated once `leavesForChain` has resolved and every leaf has
   *  been inserted. null while loading or when `enabled` is false. */
  tree: PoseidonMerkleTreeType | null;
  /** True while the Convex query is in flight or the tree is being
   *  built. */
  isLoading: boolean;
  /** Count of inserted leaves — useful for showing "syncing… N/N" UI. */
  leafCount: number;
};

export function useMerkleTree(
  chainId: number | null,
  enabled: boolean,
): MerkleTreeState {
  const rows = useQuery(
    api.shieldQueue.store.leavesForChain,
    enabled && chainId !== null ? { chainId } : "skip",
  );

  const [tree, setTree] = useState<PoseidonMerkleTreeType | null>(null);
  const [leafCount, setLeafCount] = useState(0);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (!enabled || rows === undefined) {
      setTree(null);
      setLeafCount(0);
      return;
    }
    let cancelled = false;
    setBuilding(true);
    void (async () => {
      try {
        const mod = await import("@pampalo/shared/classes/PoseidonMerkleTree");
        const next = new mod.PoseidonMerkleTree(TREE_HEIGHT);
        // initializeDefaultNodes is fire-and-forget inside the
        // constructor; its body is sync under poseidon2Hash so by the
        // time we hit `insert` the defaults are populated. A microtask
        // yield gives any async setup a chance to settle defensively.
        await Promise.resolve();
        for (const row of rows) {
          await next.insert(BigInt(row.leafCommitment), row.leafIndex);
        }
        if (cancelled) return;
        setTree(next);
        setLeafCount(rows.length);
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, rows]);

  return {
    tree,
    isLoading: enabled && (rows === undefined || building),
    leafCount,
  };
}

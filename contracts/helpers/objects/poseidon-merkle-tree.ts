import { PoseidonMerkleTree } from "@pampalo/shared/classes/PoseidonMerkleTree";
import { TREE_HEIGHT } from "@pampalo/shared/constants/tree";
import { keccak256, toUtf8Bytes } from "ethers";
import * as path from "node:path";

// On-disk-cached off-chain mirror of the on-chain merkle tree. First
// run computes the full default subtree set (2^TREE_HEIGHT zero leaves
// hashed pairwise up); subsequent runs load the serialized cache from
// `./cache/full-tree-h12.json`. The cache key embeds TREE_HEIGHT so
// changing height invalidates the cache automatically.

const ZERO_VALUE =
  BigInt(keccak256(toUtf8Bytes("TANGERINE"))) %
  BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");

const LEVELS = TREE_HEIGHT;
const TREE_CACHE_PATH = path.join(`./cache/full-tree-h${LEVELS}.json`);

export const getMerkleTree = async () => {
  let tree: PoseidonMerkleTree;
  try {
    tree = await PoseidonMerkleTree.loadFromFile(TREE_CACHE_PATH);
  } catch {
    tree = new PoseidonMerkleTree(LEVELS);

    const totalLeaves = 2 ** LEVELS;
    const insertPromises = [];
    for (let i = 0; i < totalLeaves; i++) {
      insertPromises.push(tree.insert(ZERO_VALUE, i));
    }

    await Promise.all(insertPromises);

    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(TREE_CACHE_PATH), { recursive: true });
    await tree.saveToFile(TREE_CACHE_PATH);
  }

  return tree;
};

export { PoseidonMerkleTree };

import { poseidon2Hash } from "@zkpassport/poseidon2";

// Off-chain mirror of the on-chain PoseidonMerkleTree contract.
// Used by Hardhat tests to compute expected roots without paying
// for real inserts, and by the wallet UI to build inclusion proofs
// for the spending circuits.
//
// HEIGHT and the zero-leaf seed must match the on-chain contract
// exactly (TREE_HEIGHT = 12; ZERO_VALUE = keccak256("TANGERINE") %
// BN254_PRIME) — see PoseidonMerkleTree.sol.

export class PoseidonMerkleTree {
  private levels: number;
  private hashMap: Map<string, bigint>;
  private defaultNodes: bigint[];
  private nextIndex: number;
  private currentRootIndex: number;
  public insertedLeaves: Set<number>;

  constructor(levels: number) {
    this.levels = levels;
    this.hashMap = new Map();
    this.defaultNodes = new Array(levels);
    this.initializeDefaultNodes();
    this.nextIndex = 0;
    this.currentRootIndex = 0;
    this.insertedLeaves = new Set();
  }

  private async initializeDefaultNodes() {
    // ZERO_VALUE = keccak256(abi.encodePacked("TANGERINE")) % BN254_PRIME
    this.defaultNodes[0] = BigInt(
      "0x1e2856f9f722631c878a92dc1d84283d04b76df3e1831492bdf7098c1e65e478",
    );

    for (let i = 1; i < this.levels; i++) {
      this.defaultNodes[i] = poseidon2Hash([
        this.defaultNodes[i - 1],
        this.defaultNodes[i - 1],
      ]);
    }
  }

  private getKey(level: number, index: number): string {
    return `${level}:${index}`;
  }

  public async insert(leaf: bigint | string, index: number) {
    if (index < 0 || index >= 2 ** this.levels) {
      throw new Error("Leaf index out of bounds");
    }

    const value = BigInt(leaf);

    this.insertedLeaves.add(index);
    this.nextIndex = Math.max(this.nextIndex, index + 1);

    let currentIndex = index;
    let currentHash = value;
    this.hashMap.set(this.getKey(0, currentIndex), currentHash);

    for (let i = 0; i < this.levels - 1; i++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const siblingKey = this.getKey(i, siblingIndex);

      let sibling = this.hashMap.get(siblingKey);
      if (!sibling) {
        sibling = this.defaultNodes[i];
      }

      currentHash = poseidon2Hash(
        isLeft ? [currentHash, sibling] : [sibling, currentHash],
      );

      currentIndex = Math.floor(currentIndex / 2);
      this.hashMap.set(this.getKey(i + 1, currentIndex), currentHash);
    }
  }

  public async getRoot(): Promise<bigint> {
    const rootKey = this.getKey(this.levels - 1, 0);
    const root = this.hashMap.get(rootKey);
    return root || this.defaultNodes[this.levels - 1];
  }

  public async getProof(
    index: number,
  ): Promise<{ siblings: bigint[]; indices: number[] }> {
    if (index < 0 || index >= 2 ** this.levels) {
      throw new Error("Leaf index out of bounds");
    }

    const siblings: bigint[] = [];
    const indices: number[] = [];
    let currentIndex = index;

    for (let i = 0; i < this.levels - 1; i++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const siblingKey = this.getKey(i, siblingIndex);

      let sibling = this.hashMap.get(siblingKey);
      if (!sibling) {
        sibling = this.defaultNodes[i];
      }

      siblings.push(sibling);
      indices.push(isLeft ? 1 : 0);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { siblings, indices };
  }

  public static async verifyProof(
    root: bigint,
    leaf: bigint | string,
    proof: { siblings: bigint[]; indices: number[] },
  ): Promise<boolean> {
    let currentHash = typeof leaf === "string" ? BigInt(leaf) : leaf;

    for (let i = 0; i < proof.siblings.length; i++) {
      currentHash = await poseidon2Hash(
        proof.indices[i] === 0
          ? [proof.siblings[i], currentHash]
          : [currentHash, proof.siblings[i]],
      );
    }

    return currentHash == root;
  }

  public async getLeafValue(leafIndex: number): Promise<bigint> {
    if (leafIndex < 0 || leafIndex >= 2 ** this.levels) {
      throw new Error("Leaf index out of bounds");
    }

    const leafKey = this.getKey(0, leafIndex);
    const leafValue = this.hashMap.get(leafKey);

    return leafValue || this.defaultNodes[0];
  }

  toJSON(): string {
    const hashMapObj: Record<string, string> = {};
    for (const [key, value] of this.hashMap.entries()) {
      hashMapObj[key] = value.toString();
    }

    const defaultNodesObj = this.defaultNodes.map((node) => node.toString());

    const treeData = {
      levels: this.levels,
      nextIndex: this.nextIndex,
      currentRootIndex: this.currentRootIndex,
      hashMap: hashMapObj,
      defaultNodes: defaultNodesObj,
      insertedLeaves: Array.from(this.insertedLeaves),
      timestamp: Date.now(),
      version: "1.0",
    };

    return JSON.stringify(treeData);
  }

  static async fromJSON(jsonString: string): Promise<PoseidonMerkleTree> {
    const data = JSON.parse(jsonString);

    const tree = new PoseidonMerkleTree(data.levels);

    await tree.initializeDefaultNodes();

    tree.nextIndex = data.nextIndex || 0;
    tree.currentRootIndex = data.currentRootIndex || 0;

    if (data.insertedLeaves) {
      tree.insertedLeaves = new Set(data.insertedLeaves);
    }

    tree.hashMap.clear();
    if (data.hashMap) {
      for (const [key, valueString] of Object.entries(data.hashMap)) {
        tree.hashMap.set(key, BigInt(valueString as string));
      }
    }

    if (data.defaultNodes) {
      tree.defaultNodes = (data.defaultNodes as string[]).map((nodeString) =>
        BigInt(nodeString),
      );
    }

    return tree;
  }
}

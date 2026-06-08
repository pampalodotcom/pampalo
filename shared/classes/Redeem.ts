import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import redeemCircuit from "../circuits/redeem.json" with { type: "json" };
import { getBbApi } from "./bb-api.js";

// Proof generator for the `redeem` (proof-of-payment) circuit. Mirrors
// Unshield/Transfer: one shared bb.js worker, lazy backend init. Proves
// that a note paid to a merchant exists in a known root, bound to a
// recipient + consumer contract + reference so the proof can't be
// redirected or griefed in the mempool.

export class Redeem {
  public redeemNoir: Noir;
  private _backend: UltraHonkBackend | undefined;

  constructor() {
    this.redeemNoir = new Noir(redeemCircuit as unknown as CompiledCircuit);
  }

  async init() {
    const api = await getBbApi();
    this._backend = new UltraHonkBackend(redeemCircuit.bytecode, api);
  }

  get redeemBackend(): UltraHonkBackend {
    if (!this._backend)
      throw new Error("Redeem not initialized -- call await redeem.init()");
    return this._backend;
  }
}

import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import swapCircuit from "../circuits/swap.json" with { type: "json" };
import { getBbApi } from "./bb-api.js";

export class Swap {
  public swapNoir: Noir;
  private _backend: UltraHonkBackend | undefined;

  constructor() {
    this.swapNoir = new Noir(swapCircuit as unknown as CompiledCircuit);
  }

  async init() {
    const api = await getBbApi();
    this._backend = new UltraHonkBackend(swapCircuit.bytecode, api);
  }

  get swapBackend(): UltraHonkBackend {
    if (!this._backend)
      throw new Error("Swap not initialized — call await swap.init()");
    return this._backend;
  }
}

import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import withdrawCircuit from "../circuits/withdraw.json" with { type: "json" };
import { getBbApi } from "./bb-api.js";

export class Unshield {
  public unshieldNoir: Noir;
  private _backend: UltraHonkBackend | undefined;

  constructor() {
    this.unshieldNoir = new Noir(withdrawCircuit as unknown as CompiledCircuit);
  }

  async init() {
    const api = await getBbApi();
    this._backend = new UltraHonkBackend(withdrawCircuit.bytecode, api);
  }

  get unshieldBackend(): UltraHonkBackend {
    if (!this._backend)
      throw new Error("Unshield not initialized — call await unshield.init()");
    return this._backend;
  }
}

import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import depositCircuit from "../../circuits/deposit/target/deposit.json" with { type: "json" };
import { getBbApi } from "./bb-api.js";

export class Shield {
  public shieldNoir: Noir;
  private _backend: UltraHonkBackend | undefined;

  constructor() {
    this.shieldNoir = new Noir(depositCircuit as unknown as CompiledCircuit);
  }

  async init() {
    const api = await getBbApi();
    this._backend = new UltraHonkBackend(depositCircuit.bytecode, api);
  }

  get shieldBackend(): UltraHonkBackend {
    if (!this._backend)
      throw new Error("Shield not initialized — call await shield.init()");
    return this._backend;
  }
}

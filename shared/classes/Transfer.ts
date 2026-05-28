import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import transferCircuit from "../../circuits/transfer/target/transfer.json" with { type: "json" };
import { getBbApi } from "./bb-api.js";

export class Transfer {
  public transferNoir: Noir;
  private _backend: UltraHonkBackend | undefined;

  constructor() {
    this.transferNoir = new Noir(transferCircuit as unknown as CompiledCircuit);
  }

  async init() {
    const api = await getBbApi();
    this._backend = new UltraHonkBackend(transferCircuit.bytecode, api);
  }

  get transferBackend(): UltraHonkBackend {
    if (!this._backend)
      throw new Error("Transfer not initialized — call await transfer.init()");
    return this._backend;
  }
}

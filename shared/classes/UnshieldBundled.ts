import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import transferExternalCircuit from "../circuits/transfer_external.json" with { type: "json" };
import { getBbApi } from "./bb-api.js";

export class UnshieldBundled {
  public unshieldBundledNoir: Noir;
  private _backend: UltraHonkBackend | undefined;

  constructor() {
    this.unshieldBundledNoir = new Noir(
      transferExternalCircuit as unknown as CompiledCircuit,
    );
  }

  async init() {
    const api = await getBbApi();
    this._backend = new UltraHonkBackend(
      transferExternalCircuit.bytecode,
      api,
    );
  }

  get unshieldBundledBackend(): UltraHonkBackend {
    if (!this._backend)
      throw new Error(
        "UnshieldBundled not initialized — call await unshieldBundled.init()",
      );
    return this._backend;
  }
}

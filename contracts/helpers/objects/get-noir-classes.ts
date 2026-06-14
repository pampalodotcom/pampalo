import { Shield } from "@pampalo/shared/classes/Shield";
import { Swap } from "@pampalo/shared/classes/Swap";
import { Transfer } from "@pampalo/shared/classes/Transfer";
import { Unshield } from "@pampalo/shared/classes/Unshield";
import { UnshieldBundled } from "@pampalo/shared/classes/UnshieldBundled";

// Instantiate the four proof-generating classes from @pampalo/shared
// and pre-init their backends. One bb.js worker (the singleton in
// shared/classes/bb-api) is shared across all four. Returns the
// underlying Noir + Backend instances so tests don't have to crack
// the class abstraction.

export const getNoirClasses = async () => {
  const shield = new Shield();
  const transfer = new Transfer();
  const unshield = new Unshield();
  const unshieldBundled = new UnshieldBundled();
  const swap = new Swap();

  await Promise.all([
    shield.init(),
    transfer.init(),
    unshield.init(),
    unshieldBundled.init(),
    swap.init(),
  ]);

  return {
    shieldNoir: shield.shieldNoir,
    shieldBackend: shield.shieldBackend,
    transferNoir: transfer.transferNoir,
    transferBackend: transfer.transferBackend,
    unshieldNoir: unshield.unshieldNoir,
    unshieldBackend: unshield.unshieldBackend,
    unshieldBundledNoir: unshieldBundled.unshieldBundledNoir,
    unshieldBundledBackend: unshieldBundled.unshieldBundledBackend,
    swapNoir: swap.swapNoir,
    swapBackend: swap.swapBackend,
  };
};

// Re-export the bb.js teardown so the global `after()` hook in
// `test/_teardown.test.ts` can drain the WASM worker.
export { destroyAllBb as destroyNoirApi } from "@pampalo/shared/classes/bb-teardown";

// Global mocha teardown. Tears down the bb.js Barretenberg WASM worker
// started transitively by getTestingAPI (via get-noir-classes + the
// four shared classes) so the test process can exit on its own once
// the suite finishes.
//
// Without this, mocha sits open after the last `passing` line because
// the bb.js worker thread keeps the event loop alive.

import { destroyNoirApi } from "@/helpers/objects/get-noir-classes.js";
import { destroyAllBb } from "@pampalo/shared/classes/bb-teardown";

after(async () => {
  await destroyNoirApi();
  await destroyAllBb();
});

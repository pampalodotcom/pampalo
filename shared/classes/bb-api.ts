import { Barretenberg } from "@aztec/bb.js";

let _apiPromise: Promise<Barretenberg> | undefined;

// Singleton getter. Stores the *promise* not the resolved value so
// parallel callers all await the same in-flight `Barretenberg.new()`
// — otherwise four parallel `init()` calls each get past `if (!_api)`
// before the first await resolves and we spawn four bb processes
// instead of one.
export const getBbApi = async (): Promise<Barretenberg> => {
  if (!_apiPromise) _apiPromise = Barretenberg.new();
  return await _apiPromise;
};

// Tear down the bb.js worker so the host process can exit. Safe to
// call multiple times. After this the next backend init will spin up
// a fresh Barretenberg instance.
export const destroyBbApi = async () => {
  if (!_apiPromise) return;
  const api = await _apiPromise;
  await api.destroy();
  _apiPromise = undefined;
};

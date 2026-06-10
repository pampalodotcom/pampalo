// @pampalo/sdk — headless Pampalo agent accounts.
//
// See docs/sdk-repos/sdk-README.md (in the monorepo) for the full
// architecture. This first release covers account identity + custody;
// transport, sync, store, and intents follow.

export { Account } from "./account.js";
export type { DerivedAddresses } from "./addresses.js";
export {
  POSEIDON_MAX,
  ENVELOPE_ISOLATED_SLOT,
  deriveAllAddresses,
} from "./addresses.js";
export { accountsDir, keystorePath, keystoreExists } from "./keystore.js";
export type { Keystore } from "./keystore.js";

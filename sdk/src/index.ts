// @pampalo/sdk — headless Pampalo agent accounts.
//
// See docs/sdk-repos/sdk-README.md (in the monorepo) for the full
// architecture. This first release covers account identity + custody;
// transport, sync, store, and intents follow.

export { Account } from "./account.js";
export type {
  PublicBalance,
  PrivateBalance,
  SendIntent,
  TokenRef,
} from "./account.js";
export { DEPLOYMENTS, getDeployment } from "./deployments.js";
export type { Deployment } from "./deployments.js";
export { syncDeployment } from "./sync.js";
export type { SyncResult, AccountKeys } from "./sync.js";
export type { DerivedAddresses } from "./addresses.js";
export {
  POSEIDON_MAX,
  ENVELOPE_ISOLATED_SLOT,
  deriveAllAddresses,
} from "./addresses.js";
export { accountsDir, keystorePath, keystoreExists } from "./keystore.js";
export type { Keystore } from "./keystore.js";
export { RpcTransport } from "./transport.js";
export type { RpcConfig, Transport } from "./transport.js";
export { ETH_SENTINEL, isNativeAsset } from "./constants.js";
export { Store, defaultDbPath } from "./store.js";
export type {
  StoredNote,
  NoteState,
  NoteOrigin,
  NoteFilter,
} from "./store.js";

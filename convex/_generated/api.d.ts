/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth_ceremony from "../auth/ceremony.js";
import type * as auth_node from "../auth/node.js";
import type * as balances_proxy from "../balances/proxy.js";
import type * as balances_types from "../balances/types.js";
import type * as catalog_networks from "../catalog/networks.js";
import type * as catalog_seed from "../catalog/seed.js";
import type * as catalog_tokens from "../catalog/tokens.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_alchemy from "../lib/alchemy.js";
import type * as lib_evm from "../lib/evm.js";
import type * as lib_normalize from "../lib/normalize.js";
import type * as preferences_mutations from "../preferences/mutations.js";
import type * as prices_feeds from "../prices/feeds.js";
import type * as prices_gas from "../prices/gas.js";
import type * as prices_refresh from "../prices/refresh.js";
import type * as send_proxy from "../send/proxy.js";
import type * as send_types from "../send/types.js";
import type * as shieldQueue_events from "../shieldQueue/events.js";
import type * as shieldQueue_refresh from "../shieldQueue/refresh.js";
import type * as shieldQueue_seed from "../shieldQueue/seed.js";
import type * as shieldQueue_store from "../shieldQueue/store.js";
import type * as swap_abi from "../swap/abi.js";
import type * as swap_actions from "../swap/actions.js";
import type * as swap_types from "../swap/types.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "auth/ceremony": typeof auth_ceremony;
  "auth/node": typeof auth_node;
  "balances/proxy": typeof balances_proxy;
  "balances/types": typeof balances_types;
  "catalog/networks": typeof catalog_networks;
  "catalog/seed": typeof catalog_seed;
  "catalog/tokens": typeof catalog_tokens;
  crons: typeof crons;
  http: typeof http;
  "lib/alchemy": typeof lib_alchemy;
  "lib/evm": typeof lib_evm;
  "lib/normalize": typeof lib_normalize;
  "preferences/mutations": typeof preferences_mutations;
  "prices/feeds": typeof prices_feeds;
  "prices/gas": typeof prices_gas;
  "prices/refresh": typeof prices_refresh;
  "send/proxy": typeof send_proxy;
  "send/types": typeof send_types;
  "shieldQueue/events": typeof shieldQueue_events;
  "shieldQueue/refresh": typeof shieldQueue_refresh;
  "shieldQueue/seed": typeof shieldQueue_seed;
  "shieldQueue/store": typeof shieldQueue_store;
  "swap/abi": typeof swap_abi;
  "swap/actions": typeof swap_actions;
  "swap/types": typeof swap_types;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

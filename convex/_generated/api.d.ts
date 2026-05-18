/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authNode from "../authNode.js";
import type * as crons from "../crons.js";
import type * as gas from "../gas.js";
import type * as http from "../http.js";
import type * as networks from "../networks.js";
import type * as prices from "../prices.js";
import type * as refresh from "../refresh.js";
import type * as rpcProxy from "../rpcProxy.js";
import type * as seed from "../seed.js";
import type * as tokens from "../tokens.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authNode: typeof authNode;
  crons: typeof crons;
  gas: typeof gas;
  http: typeof http;
  networks: typeof networks;
  prices: typeof prices;
  refresh: typeof refresh;
  rpcProxy: typeof rpcProxy;
  seed: typeof seed;
  tokens: typeof tokens;
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

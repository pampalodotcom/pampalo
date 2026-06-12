// Account transport — the pluggable channel for chain reads + broadcast.
//
// Day-1 is a direct RPC transport: one ethers JsonRpcProvider per chain,
// pointed at a user-supplied URL. A Convex-backed transport (relayer
// privacy + server-side note hydrate) can implement the same `Transport`
// shape later. See CONTEXT.md "Account transport".
//
// Unlike the web app's `RpcClient` (which exists to swap a Convex proxy
// for a direct client in the browser), the Node SDK has no proxy to
// abstract — so the transport simply hands out ethers providers, which
// already cover reads, fee estimation, broadcast, and getLogs (sync).

import { JsonRpcProvider, Network } from "ethers";

/** Map of chainId → JSON-RPC URL. */
export type RpcConfig = Record<number, string>;

export interface Transport {
  /** ethers provider for `chainId`. Throws if no URL is configured. */
  provider(chainId: number): JsonRpcProvider;
  /** Chain ids this transport can reach. */
  chains(): number[];
}

export class RpcTransport implements Transport {
  readonly #urls: RpcConfig;
  readonly #providers = new Map<number, JsonRpcProvider>();

  constructor(urls: RpcConfig) {
    this.#urls = { ...urls };
  }

  provider(chainId: number): JsonRpcProvider {
    let p = this.#providers.get(chainId);
    if (!p) {
      const url = this.#urls[chainId];
      if (!url) {
        throw new Error(
          `no RPC URL configured for chainId ${chainId} — pass it to useRpc()`,
        );
      }
      // staticNetwork pins the chain id so ethers skips an eth_chainId
      // probe on every call (and never silently follows a chain switch).
      p = new JsonRpcProvider(url, chainId, {
        staticNetwork: new Network(`chain-${chainId}`, chainId),
      });
      this.#providers.set(chainId, p);
    }
    return p;
  }

  chains(): number[] {
    return Object.keys(this.#urls).map(Number);
  }
}

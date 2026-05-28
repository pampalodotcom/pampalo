// Server-side helpers for Alchemy JSON-RPC. No Convex function registration
// happens here — just the URL builder and a minimal `fetch`-based RPC
// wrapper used by the proxy actions in balances/, send/, and prices/.
//
// The Alchemy API key stays inside this module by design: anything that
// touches `process.env.ALCHEMY_API_KEY` should go through `alchemyUrl()`
// so the key never escapes server code paths. See ADR 0004 for the broader
// posture around RPC proxies.

export function alchemyUrl(subdomain: string): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY not set in Convex environment.");
  return `https://${subdomain}.g.alchemy.com/v2/${key}`;
}

export async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(
      `RPC HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error) {
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error("RPC returned no result");
  }
  return body.result;
}

// Batched JSON-RPC. Used by the price/gas refresh cron to fan multiple
// `eth_call`s for Chainlink aggregators or (eth_gasPrice + eth_feeHistory)
// at one host into a single HTTP round-trip.
export type RpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};
export type RpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

export async function rpcBatch<T>(
  url: string,
  calls: Array<RpcRequest>,
): Promise<Array<RpcResponse<T>>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls),
  });
  if (!res.ok) {
    throw new Error(
      `RPC HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as Array<RpcResponse<T>>;
  if (!Array.isArray(body)) {
    throw new Error("RPC response was not an array");
  }
  return body;
}

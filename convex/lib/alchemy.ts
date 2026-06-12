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

// Bounded EIP-1559 priority fee (tip) for relayer / compliance-signer txs.
// The old hardcoded 1 gwei tip was ~100x the real cost on Base — an L2 whose
// sequencer needs almost no tip (a private transfer was costing ~$7). We take
// the node's `eth_maxPriorityFeePerGas` suggestion, floored to a small
// non-zero tip (so a 0 suggestion still lands) and capped so a spiky / bad
// RPC value can't blow up fees.
const PRIORITY_FLOOR_WEI = 1_000_000n; // 0.001 gwei
const PRIORITY_CAP_WEI = 100_000_000n; // 0.1 gwei

export async function suggestedPriorityFeeWei(url: string): Promise<bigint> {
  let suggested: bigint;
  try {
    suggested = BigInt(await rpc<string>(url, "eth_maxPriorityFeePerGas", []));
  } catch {
    suggested = 0n; // node may not support it → fall back to the floor
  }
  if (suggested < PRIORITY_FLOOR_WEI) return PRIORITY_FLOOR_WEI;
  if (suggested > PRIORITY_CAP_WEI) return PRIORITY_CAP_WEI;
  return suggested;
}

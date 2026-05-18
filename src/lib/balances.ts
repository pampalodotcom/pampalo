import { useQuery } from "@tanstack/react-query";
import { useRpcClient, type NativeBalance, type TokenBalance } from "./rpc";

// Tokens addressed by (chainId, address) — `0xeee…eee` means native. The
// hook decides which proxy call to make based on the sentinel.
export const NATIVE_SENTINEL =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type AssetRef = {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
};

// ─── Public balances (real) ──────────────────────────────────────────────
// Hits `api.rpcProxy.getNativeBalance` / `getTokenBalance` via the
// `useRpcClient()` indirection — the server holds the Alchemy API key.

type PublicBalance = {
  balanceWei: bigint;
  symbol: string;
  decimals: number;
  fetchedAt: number;
};

/**
 * Live on-chain balance. 30 s refetch interval matches the cron cadence
 * we run prices/gas on. `userAddress: null` disables the query (e.g.
 * when the wallet isn't unlocked yet).
 */
export function usePublicBalance(asset: AssetRef, userAddress: string | null) {
  const rpc = useRpcClient();
  const enabled = userAddress !== null;

  return useQuery<PublicBalance>({
    queryKey: [
      "public-balance",
      asset.chainId,
      asset.address.toLowerCase(),
      userAddress?.toLowerCase(),
    ],
    enabled,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!userAddress) throw new Error("address required");
      if (asset.address.toLowerCase() === NATIVE_SENTINEL) {
        const r: NativeBalance = await rpc.getNativeBalance(
          asset.chainId,
          userAddress,
        );
        return {
          balanceWei: BigInt(r.balanceWei),
          symbol: r.symbol,
          decimals: r.decimals,
          fetchedAt: r.fetchedAt,
        };
      }
      const r: TokenBalance = await rpc.getTokenBalance(
        {
          chainId: asset.chainId,
          tokenAddress: asset.address,
          decimals: asset.decimals,
          symbol: asset.symbol,
        },
        userAddress,
      );
      return {
        balanceWei: BigInt(r.balanceWei),
        symbol: r.symbol,
        decimals: r.decimals,
        fetchedAt: r.fetchedAt,
      };
    },
  });
}

// ─── Private balances (placeholder, async with 2s timeout) ──────────────
// Real shielded-balance lookup will walk the note tree client-side and
// decrypt entries that belong to the user. Until that lands, the hook
// pretends to do that work — same `useQuery` shape, real AbortSignal,
// real 2 s deadline — so when we swap the inner fetch for the real one
// the call sites don't change. Returning `__placeholder: true` keeps
// the lie auditable.

const PRIVATE_TIMEOUT_MS = 2_000;
const PRIVATE_STUB_LATENCY_MS = 800;

type PrivateBalance = {
  balanceWei: bigint;
  symbol: string;
  decimals: number;
  fetchedAt: number;
  /** Marker so UI can flag "this is mocked". Real hook will omit. */
  __placeholder: true;
};

// Shielded-balance lookup isn't implemented yet — every asset returns 0
// until the note-tree walker lands. The hook still goes through the
// async-with-timeout shape so call sites don't change when we swap the
// inner fetch for the real implementation.
function placeholderBalanceWei(_asset: AssetRef): bigint {
  return 0n;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * PLACEHOLDER. Real impl will decrypt notes belonging to `userAddress`
 * on `asset.chainId`, summed across confirmed blocks.
 */
async function fetchPrivateBalance(
  asset: AssetRef,
  _userAddress: string,
  signal: AbortSignal,
): Promise<bigint> {
  await delay(PRIVATE_STUB_LATENCY_MS, signal);
  return placeholderBalanceWei(asset);
}

/**
 * Race `promise` against `ms`. If the timer wins, aborts via the
 * controller and rejects with a "Timed out" error so react-query
 * surfaces it as `error` rather than waiting forever.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Private-balance lookup timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function usePrivateBalance(
  asset: AssetRef,
  userAddress: string | null,
) {
  return useQuery<PrivateBalance>({
    queryKey: [
      "private-balance",
      asset.chainId,
      asset.address.toLowerCase(),
      userAddress?.toLowerCase(),
    ],
    enabled: userAddress !== null,
    retry: false,
    // No background refetch yet — the stub is deterministic, and the
    // real lookup is going to be expensive. Manual refresh on demand
    // will go on a "Refresh" button later.
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      if (!userAddress) throw new Error("address required");
      const controller = new AbortController();
      // Bridge react-query's signal to ours so cancellation propagates
      // both ways (query unmount → abort our work; timeout → cancel
      // anything react-query may have scheduled around us).
      const onParentAbort = () => controller.abort();
      signal.addEventListener("abort", onParentAbort);
      try {
        const wei = await withTimeout(
          fetchPrivateBalance(asset, userAddress, controller.signal),
          PRIVATE_TIMEOUT_MS,
          controller,
        );
        return {
          balanceWei: wei,
          symbol: asset.symbol,
          decimals: asset.decimals,
          fetchedAt: Date.now(),
          __placeholder: true,
        };
      } finally {
        signal.removeEventListener("abort", onParentAbort);
      }
    },
  });
}

// ─── Combined helpers ────────────────────────────────────────────────────

/** Convert wei → display number with full precision (BigInt-safe). */
export function weiToNumber(wei: bigint, decimals: number): number {
  const div = 10n ** BigInt(decimals);
  const whole = Number(wei / div);
  const frac = Number(wei % div) / Number(div);
  return whole + frac;
}

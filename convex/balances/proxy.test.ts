/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import schema from '../schema'

// Glob the entire convex/ tree so convex-test can resolve cross-module
// internal references (e.g. internal.catalog.networks._networkForAction
// from balances/proxy.ts).
//
// Wart: vite's `import.meta.glob` canonicalizes paths to the shortest
// relative form, so sibling matches come back as `./proxy.ts` while
// others come back as `../auth/ceremony.ts`. convex-test's single-prefix
// lookup then fails to resolve our own module. Re-add the folder name
// to sibling keys so every key shares the same `../<folder>/...` shape.
// See ADR 0005.
const FOLDER = 'balances'
const raw = import.meta.glob('../**/*.ts')
const modules = Object.fromEntries(
  Object.entries(raw).map(([k, v]) =>
    k.startsWith('./') ? [`../${FOLDER}/${k.slice(2)}`, v] : [k, v],
  ),
)

// ─── Fixtures ────────────────────────────────────────────────────────────

const TEST_ADDRESS = process.env.TEST_ADDRESS!
const TEST_ADDRESS_LC = TEST_ADDRESS.toLowerCase()

// Ethereum mainnet token addresses from the seed catalogue.
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase()
const AUDD_MAINNET = '0x4cCe605eD955295432958d8951D0B176C10720d5'.toLowerCase()

// Base — Circle's native USDC and a placeholder AUDD (Base has no live
// AUDD deployment in the seed catalogue, but the proxy doesn't care:
// the test address is a stable input regardless of contract validity).
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const AUDD_BASE = '0x000000000000000000000000000000000000bbbb'

// 32-byte hex (no 0x) — used as the deterministic balance the mocked
// Alchemy RPC returns for any eth_getBalance / eth_call.
const NATIVE_BALANCE_HEX =
  '0x000000000000000000000000000000000000000000000000016345785d8a0000' // 0.1 ETH = 10^17 wei
const TOKEN_BALANCE_HEX =
  '0x000000000000000000000000000000000000000000000000000000000bebc200' // 200_000_000 (200 USDC at 6 decimals)

// Seed the minimum catalogue these tests need: Ethereum (1) + Base (8453).
async function seedNetworks(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.catalog.seed.addNetwork, {
    chainId: 1,
    name: 'Ethereum',
    alchemySubdomain: 'eth-mainnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    isNative: true,
    enabled: true,
  })
  await t.mutation(internal.catalog.seed.addNetwork, {
    chainId: 8453,
    name: 'Base',
    alchemySubdomain: 'base-mainnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    isNative: true,
    enabled: true,
  })
}

// ─── Fetch mock ──────────────────────────────────────────────────────────
// The proxy action's only side effect is a POST to Alchemy. We replace
// global fetch with a deterministic responder that decodes the JSON-RPC
// payload and returns canned hex, then assert the captured request shape.

type CapturedRequest = {
  url: string
  method: string
  params: unknown[]
}

const captured: CapturedRequest[] = []

beforeEach(() => {
  captured.length = 0
  process.env.ALCHEMY_API_KEY = 'test-key'

  const mockFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body = JSON.parse(init?.body as string) as {
        method: string
        params: unknown[]
      }
      captured.push({ url, method: body.method, params: body.params })

      let result: string
      if (body.method === 'eth_getBalance') {
        result = NATIVE_BALANCE_HEX
      } else if (body.method === 'eth_call') {
        result = TOKEN_BALANCE_HEX
      } else {
        throw new Error(`Unexpected RPC method ${body.method}`)
      }

      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )

  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.ALCHEMY_API_KEY
})

// ─── Tests ───────────────────────────────────────────────────────────────

describe('rpcProxy.getNativeBalance', () => {
  test('returns ETH balance on Ethereum mainnet', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    const result = await t.action(api.balances.proxy.getNativeBalance, {
      chainId: 1,
      address: TEST_ADDRESS,
    })

    expect(result).toMatchObject({
      chainId: 1,
      address: TEST_ADDRESS_LC,
      balanceWei: '100000000000000000', // 0.1 ETH
      decimals: 18,
      symbol: 'ETH',
      isNative: true,
    })
    expect(typeof result.fetchedAt).toBe('number')

    // Verify the proxy hit the right Alchemy host with eth_getBalance(addr).
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://eth-mainnet.g.alchemy.com/v2/test-key',
    )
    expect(captured[0].method).toBe('eth_getBalance')
    expect(captured[0].params).toEqual([TEST_ADDRESS_LC, 'latest'])
  })

  test('returns ETH balance on Base', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    const result = await t.action(api.balances.proxy.getNativeBalance, {
      chainId: 8453,
      address: TEST_ADDRESS,
    })

    expect(result.symbol).toBe('ETH')
    expect(result.balanceWei).toBe('100000000000000000')
    expect(captured[0].url).toBe(
      'https://base-mainnet.g.alchemy.com/v2/test-key',
    )
  })

  test('rejects unknown chainId', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    await expect(
      t.action(api.balances.proxy.getNativeBalance, {
        chainId: 999,
        address: TEST_ADDRESS,
      }),
    ).rejects.toThrow(/Unknown or disabled chainId 999/)
  })

  test('rejects malformed address', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    await expect(
      t.action(api.balances.proxy.getNativeBalance, {
        chainId: 1,
        address: 'not-an-address',
      }),
    ).rejects.toThrow(/Invalid address/)
  })
})

describe('rpcProxy.getTokenBalance', () => {
  test('returns USDC balance on Ethereum mainnet', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    const result = await t.action(api.balances.proxy.getTokenBalance, {
      chainId: 1,
      address: TEST_ADDRESS,
      tokenAddress: USDC_MAINNET,
      decimals: 6,
      symbol: 'USDC',
    })

    expect(result).toMatchObject({
      chainId: 1,
      address: TEST_ADDRESS_LC,
      tokenAddress: USDC_MAINNET,
      balanceWei: '200000000',
      decimals: 6,
      symbol: 'USDC',
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://eth-mainnet.g.alchemy.com/v2/test-key',
    )
    expect(captured[0].method).toBe('eth_call')
    // params: [{ to, data }, "latest"]
    const callParams = captured[0].params as [
      { to: string; data: string },
      string,
    ]
    expect(callParams[0].to).toBe(USDC_MAINNET)
    // data should be balanceOf selector + left-padded user address.
    expect(callParams[0].data).toBe(
      '0x70a08231' + '000000000000000000000000' + TEST_ADDRESS_LC.slice(2),
    )
    expect(callParams[1]).toBe('latest')
  })

  test('returns AUDD balance on Ethereum mainnet', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    const result = await t.action(api.balances.proxy.getTokenBalance, {
      chainId: 1,
      address: TEST_ADDRESS,
      tokenAddress: AUDD_MAINNET,
      decimals: 6,
      symbol: 'AUDD',
    })

    expect(result.symbol).toBe('AUDD')
    expect(result.tokenAddress).toBe(AUDD_MAINNET)
    expect(result.balanceWei).toBe('200000000')
    const callParams = captured[0].params as [
      { to: string; data: string },
      string,
    ]
    expect(callParams[0].to).toBe(AUDD_MAINNET)
  })

  test('returns USDC balance on Base', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    const result = await t.action(api.balances.proxy.getTokenBalance, {
      chainId: 8453,
      address: TEST_ADDRESS,
      tokenAddress: USDC_BASE,
      decimals: 6,
      symbol: 'USDC',
    })

    expect(result.chainId).toBe(8453)
    expect(result.tokenAddress).toBe(USDC_BASE)
    expect(captured[0].url).toBe(
      'https://base-mainnet.g.alchemy.com/v2/test-key',
    )
  })

  test('returns AUDD balance on Base', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    const result = await t.action(api.balances.proxy.getTokenBalance, {
      chainId: 8453,
      address: TEST_ADDRESS,
      tokenAddress: AUDD_BASE,
      decimals: 6,
      symbol: 'AUDD',
    })

    expect(result.symbol).toBe('AUDD')
    expect(captured[0].url).toBe(
      'https://base-mainnet.g.alchemy.com/v2/test-key',
    )
    const callParams = captured[0].params as [
      { to: string; data: string },
      string,
    ]
    expect(callParams[0].to).toBe(AUDD_BASE)
  })

  test('rejects malformed token address', async () => {
    const t = convexTest(schema, modules)
    await seedNetworks(t)

    await expect(
      t.action(api.balances.proxy.getTokenBalance, {
        chainId: 1,
        address: TEST_ADDRESS,
        tokenAddress: '0xnotatoken',
        decimals: 6,
        symbol: 'USDC',
      }),
    ).rejects.toThrow(/Invalid address/)
  })
})

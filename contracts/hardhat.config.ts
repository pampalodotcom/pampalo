import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import HardhatIgnitionEthersPlugin from "@nomicfoundation/hardhat-ignition-ethers";
import { defineConfig } from "hardhat/config";

// Prefer a contracts/.env if one exists, otherwise fall back to the
// repo-root .env. Avoids duplicating ALCHEMY_API_KEY / MNEMONIC /
// ETHERSCAN_API_KEY between the wallet half (vite + convex) and the
// contracts package — most local-dev setups will keep everything in
// the root file. `existsSync` instead of letting dotenv try-and-fail
// because dotenv prints a warning on miss, which clutters every
// `hardhat compile` / `hardhat test` run.
const here = dirname(fileURLToPath(import.meta.url));
const localEnv = resolve(here, ".env");

const rootEnv = resolve(here, "../.env.local");
dotenv.config({ path: existsSync(localEnv) ? localEnv : rootEnv });

// Lightweight Hardhat 3 setup using the mocha + ethers toolbox (no
// viem). Networks below are opt-in via env vars; the default network
// for `pnpm test` is the in-process Hardhat network — no RPC needed.

// ─── Env-driven URL + signer composition ────────────────────────────────
// Single ALCHEMY_API_KEY drives RPC URLs for every chain (same shape
// as convex/rpcProxy.ts: https://{subdomain}.g.alchemy.com/v2/{key}).
// One MNEMONIC drives signers via Hardhat's HD-wallet accounts shape
// (BIP-44 path m/44'/60'/0'/0/N).
//
// Both fall back to "no-op" defaults so missing env vars don't crash
// the config loader: tests on the in-process network keep working,
// and `pnpm compile` is unaffected. The network just becomes
// unusable for live deploys until both are set.
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const MNEMONIC = process.env.MNEMONIC ?? "";

function alchemyUrl(subdomain: string): string {
  return ALCHEMY_KEY
    ? `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`
    : "";
}

// HD-wallet accounts shape — Hardhat derives signers from the
// mnemonic on demand. Empty list when MNEMONIC is unset so the
// config still loads (read-only access via any network is fine).
const hdAccounts = MNEMONIC ? { mnemonic: MNEMONIC } : [];

// v2 deployer: MNEMONIC accounts[1]. Nonce-0 on both Base + Base Sepolia,
// so deploying from it yields identical CREATE addresses across the two
// chains. Base + baseSepolia use this; signers[0] on those networks is
// therefore derivation index 1. See DEPLOYMENT.md / ADR 0017.
const hdAccountsV2 = MNEMONIC
  ? { mnemonic: MNEMONIC, initialIndex: 1, count: 10 }
  : [];

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin, HardhatIgnitionEthersPlugin],

  paths: {
    sources: "./contracts",
  },

  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 100 },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 100 },
        },
      },
    },
  },

  networks: {
    // In-process mainnet fork for the pampalo.eth username tests. Forks
    // real ENS + NameWrapper + the Chainlink ETH/USD feed so the registrar
    // is exercised against production bytecode/state. Selected explicitly
    // in test/pampalo.eth.test.ts via `network.connect('mainnetFork')`; the
    // rest of the suite keeps using the default keyless network. Pin
    // FORK_BLOCK for determinism + RPC caching; omitted => recent block.
    mainnetFork: {
      type: "edr-simulated",
      chainId: 1,
      forking: {
        url: alchemyUrl("eth-mainnet"),
        ...(process.env.FORK_BLOCK
          ? { blockNumber: Number(process.env.FORK_BLOCK) }
          : {}),
      },
    },
    // In-process Base mainnet fork — used to dry-run the swap-venue
    // deploy (scripts/deploy-swap.ts) and the forked-liquidity swap
    // tests against real Base Uniswap before any live deploy. Keyless
    // funded signers; no real ETH spent.
    baseFork: {
      type: "edr-simulated",
      chainId: 8453,
      forking: {
        url: alchemyUrl("base-mainnet"),
        ...(process.env.FORK_BLOCK
          ? { blockNumber: Number(process.env.FORK_BLOCK) }
          : {}),
      },
    },
    // Mainnet + Base + Sepolia mirror the chains the wallet half of
    // this project supports (see convex/uniswap.ts UNISWAP_ADDRESSES
    // and convex/seed.ts NETWORKS). Subdomains match convex's
    // alchemyUrl() helper exactly so the two halves stay in sync.
    mainnet: {
      type: "http",
      url: alchemyUrl("eth-mainnet"),
      accounts: hdAccounts,
      chainId: 1,
    },
    base: {
      type: "http",
      // BASE_RPC_URL overrides the Alchemy URL. Alchemy's
      // eth_getTransactionCount lags a just-submitted tx by a few
      // seconds, which trips Ignition's strict nonce manager mid-deploy;
      // pointing at the Base sequencer RPC (https://mainnet.base.org)
      // for deploys avoids that.
      url: process.env.BASE_RPC_URL || alchemyUrl("base-mainnet"),
      accounts: hdAccountsV2,
      chainId: 8453,
    },
    sepolia: {
      type: "http",
      url: alchemyUrl("eth-sepolia"),
      accounts: hdAccounts,
      chainId: 11155111,
    },
    baseSepolia: {
      type: "http",
      url: alchemyUrl("base-sepolia"),
      accounts: hdAccountsV2,
      chainId: 84532,
    },
  },

  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY ?? "",
    },
  },
});

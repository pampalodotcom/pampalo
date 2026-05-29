// Event signature constants + ABI decoders for the shield-queue
// indexer. Pampalo emits six events the indexer cares about; this
// file precomputes their topic-0 hashes once and offers a tiny
// strongly-typed decoder for each.
//
// We use ethers rather than rolling our own keccak/ABI decode because
// the Convex V8 runtime already imports ethers in convex/swap/abi.ts
// for Uniswap encoding, so we're not pulling in a fresh dep — and
// hand-rolling secp/ABI is the kind of code where being wrong is
// invisible until a corner case bites at mainnet.

import { AbiCoder, id, getAddress } from "ethers";
import { lowerAddress, lowerHash, uint256ToString } from "../lib/normalize";

// ─── Signatures + topic-0 hashes ─────────────────────────────────────────

// Keep these strings literal — they're the canonical event signatures
// the contract emits, and topic-0 is `keccak256(signature)`.
const SIG_SHIELD_QUEUED =
  "ShieldQueued(uint256,address,address,uint256,uint256,uint64,bytes)";
const SIG_SHIELD_EXECUTED = "ShieldExecuted(uint256)";
const SIG_SHIELD_CANCELLED = "ShieldCancelled(uint256,address)";
const SIG_SHIELD_CONTESTED = "ShieldContested(uint256,address,string)";
const SIG_ASSET_SUPPORTED = "AssetSupported(address,address)";
const SIG_ASSET_DISABLED = "AssetDisabled(address)";

export const TOPIC = {
  shieldQueued: id(SIG_SHIELD_QUEUED),
  shieldExecuted: id(SIG_SHIELD_EXECUTED),
  shieldCancelled: id(SIG_SHIELD_CANCELLED),
  shieldContested: id(SIG_SHIELD_CONTESTED),
  assetSupported: id(SIG_ASSET_SUPPORTED),
  assetDisabled: id(SIG_ASSET_DISABLED),
} as const;

/** Every topic-0 we'd ask `eth_getLogs` to filter on. */
export const ALL_TOPICS: readonly string[] = Object.values(TOPIC);

// ─── Log shape ───────────────────────────────────────────────────────────

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;     // hex
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
};

// ─── Decoders ────────────────────────────────────────────────────────────

const abi = AbiCoder.defaultAbiCoder();

/** Indexed `address` topics are 32-byte left-zero-padded. Slice + checksum. */
function addressFromTopic(topic: string): string {
  // last 20 bytes = last 40 hex chars (+ "0x" prefix)
  const padded = topic.toLowerCase();
  const slice = "0x" + padded.slice(26);
  // Round-trip through getAddress for an EIP-55 sanity check, then lowercase.
  return lowerAddress(getAddress(slice));
}

function uint256FromTopic(topic: string): string {
  return uint256ToString(BigInt(topic));
}

export type DecodedShieldQueued = {
  kind: "ShieldQueued";
  pendingId: string;           // decimal
  shielder: string;            // lowercased
  asset: string;               // lowercased
  amount: string;              // decimal
  leafCommitment: string;      // 0x… 32-byte hex (lowercased)
  unlockTime: number;          // unix seconds — uint64 fits in JS number
  encryptedPayload: ArrayBuffer; // raw ECIES bytes
};

export type DecodedShieldExecuted = {
  kind: "ShieldExecuted";
  pendingId: string;
};

export type DecodedShieldCancelled = {
  kind: "ShieldCancelled";
  pendingId: string;
  by: string;                  // lowercased
};

export type DecodedShieldContested = {
  kind: "ShieldContested";
  pendingId: string;
  by: string;                  // lowercased
  reason: string;
};

export type DecodedAssetSupported = {
  kind: "AssetSupported";
  asset: string;
  oracle: string;
};

export type DecodedAssetDisabled = {
  kind: "AssetDisabled";
  asset: string;
};

export type DecodedEvent =
  | DecodedShieldQueued
  | DecodedShieldExecuted
  | DecodedShieldCancelled
  | DecodedShieldContested
  | DecodedAssetSupported
  | DecodedAssetDisabled;

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex}`);
  }
  const buf = new ArrayBuffer(clean.length / 2);
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) {
    view[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/**
 * Decode a raw log against the known Pampalo event surface. Returns
 * `null` for any topic we don't recognise (e.g. a future event added
 * to the contract — fail open, log, move on).
 */
export function decodeLog(log: RawLog): DecodedEvent | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return null;

  switch (topic0) {
    case TOPIC.shieldQueued.toLowerCase(): {
      // topics: [topic0, id, shielder, asset]
      // data:   (uint256 amount, uint256 leafCommitment, uint64 unlockTime, bytes encryptedPayload)
      const [amount, leafCommitment, unlockTime, encryptedPayload] = abi.decode(
        ["uint256", "uint256", "uint64", "bytes"],
        log.data,
      ) as unknown as [bigint, bigint, bigint, string];
      return {
        kind: "ShieldQueued",
        pendingId: uint256FromTopic(log.topics[1]!),
        shielder: addressFromTopic(log.topics[2]!),
        asset: addressFromTopic(log.topics[3]!),
        amount: uint256ToString(amount),
        leafCommitment: lowerHash(
          "0x" + leafCommitment.toString(16).padStart(64, "0"),
        ),
        unlockTime: Number(unlockTime), // uint64 fits comfortably in JS number
        encryptedPayload: hexToArrayBuffer(encryptedPayload),
      };
    }

    case TOPIC.shieldExecuted.toLowerCase(): {
      return {
        kind: "ShieldExecuted",
        pendingId: uint256FromTopic(log.topics[1]!),
      };
    }

    case TOPIC.shieldCancelled.toLowerCase(): {
      return {
        kind: "ShieldCancelled",
        pendingId: uint256FromTopic(log.topics[1]!),
        by: addressFromTopic(log.topics[2]!),
      };
    }

    case TOPIC.shieldContested.toLowerCase(): {
      // data: (string reason)
      const [reason] = abi.decode(["string"], log.data) as unknown as [string];
      return {
        kind: "ShieldContested",
        pendingId: uint256FromTopic(log.topics[1]!),
        by: addressFromTopic(log.topics[2]!),
        reason,
      };
    }

    case TOPIC.assetSupported.toLowerCase(): {
      return {
        kind: "AssetSupported",
        asset: addressFromTopic(log.topics[1]!),
        oracle: addressFromTopic(log.topics[2]!),
      };
    }

    case TOPIC.assetDisabled.toLowerCase(): {
      return {
        kind: "AssetDisabled",
        asset: addressFromTopic(log.topics[1]!),
      };
    }

    default:
      return null;
  }
}

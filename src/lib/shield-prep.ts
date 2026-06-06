// Pure helpers for preparing a `shieldNative` transaction. Lazy-loads
// the heavy proof-gen + ECIES dependencies so the bb.js WASM bundle
// only enters the browser bundle when the user actually hits Confirm
// on the slider's shield action.
//
// Scope (matches the user-paused build order): native ETH only. The
// ERC-20 path (`shield` + ERC20 approve preamble) lands in a follow-up
// slice. See SHIELD_FLOW.md §7.1 for the surrounding flow.

import { Interface } from "ethers";
import { POSEIDON_MAX } from "./derive-addresses";
import { ETH_SENTINEL } from "./eth";

const ETH_ASSET_ID = BigInt(ETH_SENTINEL);

const SHIELD_NATIVE_IFACE = new Interface([
  "function shieldNative(bytes proof, bytes32[] publicInputs, bytes encryptedPayload) external payable returns (uint256 id)",
]);
const SHIELD_ERC20_IFACE = new Interface([
  "function shield(address erc20, uint256 amount, bytes proof, bytes32[] publicInputs, bytes encryptedPayload) external returns (uint256 id)",
]);
const ERC20_APPROVE_IFACE = new Interface([
  "function approve(address spender, uint256 value) external returns (bool)",
]);

/**
 * Encode the calldata for an `IERC20.approve(spender, value)` call.
 * Used by the ERC-20 shield path so we can sign approve + shield in
 * the same PRF ceremony and broadcast them with sequential nonces.
 */
export function buildErc20Approve(
  tokenAddress: string,
  spender: string,
  amount: bigint,
): { to: string; data: string; value: string } {
  return {
    to: tokenAddress.toLowerCase(),
    data: ERC20_APPROVE_IFACE.encodeFunctionData("approve", [spender, amount]),
    value: "0",
  };
}

export type ShieldNativeInput = {
  /** Amount of ETH to shield, in wei. */
  amount: bigint;
  /** Chain to shield on — feeds the eventual unsigned-tx envelope. */
  chainId: number;
  /** Lowercased 0x… Pampalo router address on `chainId`. */
  pampaloAddress: string;
  /** The user's own Poseidon identifier (0x + 64 hex). Owner of the note. */
  ownerPoseidon: string;
  /** Uncompressed secp256k1 public key (0x04 || X || Y) for ECIES. */
  envelopePubKey: string;
};

export type PreparedShieldNativeTx = {
  /** Unsigned-tx envelope. Feed into signTransactionWithPasskey. */
  to: string;
  data: string;
  value: string; // decimal wei
  chainId: number;

  // Surfaced so the caller (a) can populate IDB optimistically once the
  // ShieldQueued receipt lands and (b) can show the leaf in a dev panel.
  leafCommitment: string; // 0x + 64 hex
  secret: string; // decimal string
  encryptedPayload: string; // 0x hex (ECIES ciphertext)
  publicInputs: readonly string[]; // 0x… hex; sized 3 (hash, asset_id, asset_amount)
  proofBytes: string; // 0x hex (UltraHonk proof)
};

// ─── Background prefetch / warmup ────────────────────────────────────────
//
// First-shield latency is dominated by three things:
//
//   1. Network-fetching the JS chunk that contains the Shield class +
//      the deposit circuit JSON (~MBs).
//   2. Compiling + loading the bb.js WASM blob in a worker.
//   3. Constructing `UltraHonkBackend` from the deposit circuit bytecode.
//
// All three are safe to do speculatively as soon as the wallet route
// mounts — they read no per-user secrets. We cache the promise so
// concurrent shields don't double-warm, and so `prepareShieldNative`
// awaits the prefetch if it's already in flight.

type WarmModules = {
  // Boxed so the cached promise resolves to a typed handle even when
  // the underlying types come from a dynamically-imported module.
  Shield: unknown;
  NoteEncryption: unknown;
  poseidon2Hash: unknown;
};

let _warmPromise: Promise<WarmModules> | null = null;

async function loadModules(): Promise<WarmModules> {
  const [shieldMod, noteMod, poseidonMod] = await Promise.all([
    import("@pampalo/shared/classes/Shield"),
    import("@pampalo/shared/classes/Note"),
    import("@zkpassport/poseidon2"),
  ]);
  return {
    Shield: shieldMod.Shield,
    NoteEncryption: noteMod.NoteEncryption,
    poseidon2Hash: poseidonMod.poseidon2Hash,
  };
}

/**
 * Kick off the prover + ECIES dependency download and bb.js WASM
 * warmup. Safe to call multiple times — only the first call does work.
 * Mount this from the wallet route via `requestIdleCallback` so it
 * runs after the page is interactive.
 */
export function warmShield(): Promise<void> {
  if (!_warmPromise) _warmPromise = loadModules();
  return _warmPromise.then(async (mods) => {
    // The bb.js singleton is what's actually expensive; instantiate a
    // Shield + run init() so the bb worker is alive before the user
    // taps Confirm. Subsequent prepareShieldNative calls construct
    // their own Shield but reuse the shared bb.js api (singleton in
    // @pampalo/shared/classes/bb-api.ts).
    type ShieldCtor = new () => { init: () => Promise<void> };
    const shield = new (mods.Shield as ShieldCtor)();
    await shield.init();
  });
}

async function getWarmModules(): Promise<WarmModules> {
  if (!_warmPromise) _warmPromise = loadModules();
  return await _warmPromise;
}

/**
 * Cryptographically random 256-bit secret in `[0, BN254_FIELD_PRIME)`.
 * Reject-sample to avoid the modulo bias that a naïve `% PRIME` would
 * introduce — small, but cheap to fix and standard.
 */
export function randomSecret(): bigint {
  const bytes = new Uint8Array(32);
  // Bounded loop: the rejection rate is ~5% so 30+ rejects in a row is
  // a defect, not bad luck — fail loudly rather than spin forever.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    crypto.getRandomValues(bytes);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    if (v < POSEIDON_MAX) return v;
  }
  throw new Error("randomSecret: rejection sampling failed 30× in a row");
}

/**
 * Build everything needed to broadcast a `shieldNative` tx — proof,
 * encrypted payload, calldata, value — without actually broadcasting.
 * The caller wraps this in their signing flow.
 */
export async function prepareShieldNative(
  input: ShieldNativeInput,
): Promise<PreparedShieldNativeTx> {
  const { amount, chainId, pampaloAddress, ownerPoseidon, envelopePubKey } =
    input;
  if (amount <= 0n) throw new Error("amount must be > 0");

  const secret = randomSecret();
  const owner = BigInt(ownerPoseidon);

  // Reuse the warm-cached modules when the wallet route has already
  // pre-fetched them. First-call latency on a cold cache is what
  // warmShield() exists to absorb (see comment at top of file).
  const mods = await getWarmModules();
  type ShieldCtor = new () => {
    init: () => Promise<void>;
    shieldNoir: {
      execute: (
        witness: Record<string, string>,
      ) => Promise<{ witness: Uint8Array }>;
    };
    shieldBackend: {
      generateProof: (
        witness: Uint8Array,
        opts: { keccakZK: boolean },
      ) => Promise<{ proof: Uint8Array | string; publicInputs: string[] }>;
    };
  };
  type NoteEncryptionStatic = {
    encryptNoteData: (
      data: {
        secret: string | bigint;
        owner: string | bigint;
        asset_id: string | bigint;
        asset_amount: string | bigint;
      },
      pub: string,
    ) => Promise<string>;
  };
  const Shield = mods.Shield as ShieldCtor;
  const NoteEncryption = mods.NoteEncryption as NoteEncryptionStatic;
  const poseidon2Hash = mods.poseidon2Hash as (xs: bigint[]) => bigint;

  // Leaf = poseidon2([asset_id, asset_amount, owner, secret]).
  // Order matches the noir witness builder in
  // contracts/helpers/functions/shield.ts.
  const leafBig = poseidon2Hash([ETH_ASSET_ID, amount, owner, secret]);
  const leafCommitment = "0x" + leafBig.toString(16).padStart(64, "0");

  // ECIES-encrypt the four-tuple to the user's own envelope key. The
  // recipient is always self for v1 (see ADR 0008), so envelopePubKey
  // is the *shielder's* uncompressed secp pub.
  const encryptedPayload = await NoteEncryption.encryptNoteData(
    {
      secret,
      owner,
      asset_id: ETH_ASSET_ID,
      asset_amount: amount,
    },
    envelopePubKey,
  );

  // Witness + proof. Witness fields must match the deposit circuit's
  // expected names (see noir source under circuits/deposit/).
  const shield = new Shield();
  await shield.init();
  const { witness } = await shield.shieldNoir.execute({
    hash: leafBig.toString(),
    asset_id: ETH_ASSET_ID.toString(),
    asset_amount: amount.toString(),
    owner: owner.toString(),
    secret: secret.toString(),
  });
  const proof = await shield.shieldBackend.generateProof(witness, {
    keccakZK: true,
  });

  // Normalise proof bytes to 0x-hex regardless of bb.js return shape
  // (Uint8Array on newer builds, hex string on older).
  const proofBytes =
    typeof proof.proof === "string"
      ? proof.proof
      : "0x" +
        Array.from(proof.proof)
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");

  // publicInputs comes back as 0x… hex strings already, but cast for
  // type safety against bb.js's loose return type.
  const publicInputs = (proof.publicInputs as readonly string[]).map(
    (s) => s,
  ) as readonly string[];

  const data = SHIELD_NATIVE_IFACE.encodeFunctionData("shieldNative", [
    proofBytes,
    publicInputs,
    encryptedPayload,
  ]);

  return {
    to: pampaloAddress,
    data,
    value: amount.toString(),
    chainId,
    leafCommitment,
    secret: secret.toString(),
    encryptedPayload,
    publicInputs,
    proofBytes,
  };
}

// ─── ERC-20 shield ───────────────────────────────────────────────────────

export type ShieldErc20Input = {
  /** Lowercased ERC-20 contract address. Treated as the witness's
   *  `asset_id` after BigInt-conversion. */
  tokenAddress: string;
  /** Amount in token base units. */
  amount: bigint;
  chainId: number;
  pampaloAddress: string;
  ownerPoseidon: string;
  envelopePubKey: string;
};

export type PreparedShieldErc20Tx = {
  to: string;
  data: string;
  /** Always "0" — ERC-20 shield carries no ETH value. */
  value: string;
  chainId: number;
  leafCommitment: string;
  secret: string;
  encryptedPayload: string;
  publicInputs: readonly string[];
  proofBytes: string;
  /** Echo of the spent token so the confirm sheet can render
   *  symbol/amount without re-resolving. */
  tokenAddress: string;
  amount: string;
};

/**
 * ERC-20 sibling of `prepareShieldNative`. Witness layout is
 * identical (asset_id is the token's address as a uint160, asset_amount
 * is base units); calldata uses `shield(asset, amount, ...)` instead
 * of the payable `shieldNative(...)`.
 */
export async function prepareShieldErc20(
  input: ShieldErc20Input,
): Promise<PreparedShieldErc20Tx> {
  const {
    tokenAddress,
    amount,
    chainId,
    pampaloAddress,
    ownerPoseidon,
    envelopePubKey,
  } = input;
  if (amount <= 0n) throw new Error("amount must be > 0");

  const secret = randomSecret();
  const owner = BigInt(ownerPoseidon);
  const assetId = BigInt(tokenAddress);

  const mods = await getWarmModules();
  type ShieldCtor = new () => {
    init: () => Promise<void>;
    shieldNoir: {
      execute: (
        witness: Record<string, string>,
      ) => Promise<{ witness: Uint8Array }>;
    };
    shieldBackend: {
      generateProof: (
        witness: Uint8Array,
        opts: { keccakZK: boolean },
      ) => Promise<{ proof: Uint8Array | string; publicInputs: string[] }>;
    };
  };
  type NoteEncryptionStatic = {
    encryptNoteData: (
      data: {
        secret: string | bigint;
        owner: string | bigint;
        asset_id: string | bigint;
        asset_amount: string | bigint;
      },
      pub: string,
    ) => Promise<string>;
  };
  const Shield = mods.Shield as ShieldCtor;
  const NoteEncryption = mods.NoteEncryption as NoteEncryptionStatic;
  const poseidon2Hash = mods.poseidon2Hash as (xs: bigint[]) => bigint;

  const leafBig = poseidon2Hash([assetId, amount, owner, secret]);
  const leafCommitment = "0x" + leafBig.toString(16).padStart(64, "0");

  const encryptedPayload = await NoteEncryption.encryptNoteData(
    {
      secret,
      owner,
      asset_id: assetId,
      asset_amount: amount,
    },
    envelopePubKey,
  );

  const shield = new Shield();
  await shield.init();
  const { witness } = await shield.shieldNoir.execute({
    hash: leafBig.toString(),
    asset_id: assetId.toString(),
    asset_amount: amount.toString(),
    owner: owner.toString(),
    secret: secret.toString(),
  });
  const proof = await shield.shieldBackend.generateProof(witness, {
    keccakZK: true,
  });

  const proofBytes =
    typeof proof.proof === "string"
      ? proof.proof
      : "0x" +
        Array.from(proof.proof)
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");
  const publicInputs = (proof.publicInputs as readonly string[]).map(
    (s) => s,
  ) as readonly string[];

  const data = SHIELD_ERC20_IFACE.encodeFunctionData("shield", [
    tokenAddress,
    amount,
    proofBytes,
    publicInputs,
    encryptedPayload,
  ]);

  return {
    to: pampaloAddress,
    data,
    value: "0",
    chainId,
    leafCommitment,
    secret: secret.toString(),
    encryptedPayload,
    publicInputs,
    proofBytes,
    tokenAddress: tokenAddress.toLowerCase(),
    amount: amount.toString(),
  };
}

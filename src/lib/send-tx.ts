// Pure helpers for building Send transactions. Produces the
// `{to, data, value}` triple that the rpcProxy gas-estimator and signer
// take as input. No RPC, no Convex — keeps the modal logic testable.

import { Interface } from "ethers";

// `transfer(address,uint256)` selector + the ERC-20 ABI fragment ethers
// needs to encode the call.
const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];
const erc20Iface = new Interface(ERC20_TRANSFER_ABI);

// Matches the sentinel in convex/seed.ts / supportedTokens.address.
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isNativeToken(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() === NATIVE_SENTINEL;
}

export type SendTxFields = {
  to: string;
  data: string;
  value: string; // decimal wei
};

export type BuildSendTxParams = {
  /** Token being moved. Use the native sentinel for ETH. */
  tokenAddress: string;
  /** Recipient EVM address. Caller is responsible for trimming/validating. */
  recipient: string;
  /** Amount in the token's smallest units (wei for ETH, 10^decimals for tokens). */
  amountWei: bigint;
};

/** Build the unsigned `{to,data,value}` for a Send. ETH transfers go
 *  straight to the recipient with empty calldata; ERC-20 transfers call
 *  `transfer(recipient, amount)` on the token contract with zero value. */
export function buildSendTx(p: BuildSendTxParams): SendTxFields {
  if (isNativeToken(p.tokenAddress)) {
    return {
      to: p.recipient,
      data: "0x",
      value: p.amountWei.toString(),
    };
  }
  const data = erc20Iface.encodeFunctionData("transfer", [
    p.recipient,
    p.amountWei,
  ]);
  return {
    to: p.tokenAddress,
    data,
    value: "0",
  };
}

/** Strict 0x[40-hex] check. Lower-cases and returns null on mismatch
 *  so the UI can branch on validity rather than throwing inside an
 *  onChange. Does NOT enforce checksum-case — too easy to false-reject
 *  pastes from third-party tools that lowercase by default. */
export function normalizeRecipient(input: string): string | null {
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  return s.toLowerCase();
}

// CLI plumbing: hidden secret prompts, RPC resolution, amount formatting.
// No protocol logic lives here — that's all in @pampalo/sdk.

import { createInterface } from "node:readline";
import { formatUnits, parseUnits } from "ethers";

/** Prompt without echoing keystrokes (passphrase / mnemonic entry). */
export function promptSecret(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let muted = false;
    // readline calls _writeToOutput for the prompt and every keystroke;
    // write the prompt once, then swallow echoes.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      (s: string) => {
        if (!muted) process.stdout.write(s);
      };
    process.stdout.write(query);
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export function promptLine(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Resolve a passphrase: --passphrase flag → PAMPALO_PASSPHRASE → prompt.
 *  When `confirm`, asks twice and checks they match. */
export async function getPassphrase(
  flag: string | undefined,
  confirm = false,
): Promise<string> {
  if (flag) return flag;
  if (process.env.PAMPALO_PASSPHRASE) return process.env.PAMPALO_PASSPHRASE;
  const pass = await promptSecret("Passphrase: ");
  if (!pass) throw new Error("passphrase required");
  if (confirm) {
    const again = await promptSecret("Confirm passphrase: ");
    if (pass !== again) throw new Error("passphrases do not match");
  }
  return pass;
}

// chainId → Alchemy subdomain (matches convex/rpcProxy.ts + hardhat.config.ts)
const ALCHEMY_SUBDOMAIN: Record<number, string> = {
  1: "eth-mainnet",
  8453: "base-mainnet",
  11155111: "eth-sepolia",
  84532: "base-sepolia",
};

/** Resolve an RPC URL: --rpc flag → PAMPALO_RPC → Alchemy from
 *  ALCHEMY_API_KEY → error. */
export function resolveRpc(chainId: number, flag: string | undefined): string {
  if (flag) return flag;
  if (process.env.PAMPALO_RPC) return process.env.PAMPALO_RPC;
  const key = process.env.ALCHEMY_API_KEY;
  const sub = ALCHEMY_SUBDOMAIN[chainId];
  if (key && sub) return `https://${sub}.g.alchemy.com/v2/${key}`;
  throw new Error(
    `no RPC for chain ${chainId} — pass --rpc <url>, or set PAMPALO_RPC / ALCHEMY_API_KEY`,
  );
}

export function fmt(amountBaseUnits: string, decimals: number): string {
  return formatUnits(amountBaseUnits, decimals);
}

export function parseAmount(human: string, decimals: number): bigint {
  return parseUnits(human, decimals);
}

export function out(json: boolean, human: () => void, data: unknown): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

export function fail(message: string): never {
  console.error("error:", message);
  process.exit(1);
}

#!/usr/bin/env node
// pampalo — drive a headless Pampalo agent account. Thin wrapper over
// @pampalo/sdk: parse args, call the SDK, format output. No protocol logic.

import { Command } from "commander";
import { Account, DEPLOYMENTS, ETH_SENTINEL } from "@pampalo/sdk";
import {
  fail,
  fmt,
  getPassphrase,
  out,
  parseAmount,
  promptSecret,
  resolveRpc,
} from "./util.js";

// Convenience: pick up ALCHEMY_API_KEY / PAMPALO_* from a local .env(.local)
// in the working directory. Best-effort — absent files are ignored.
for (const f of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* no such env file */
  }
}

const program = new Command();
program
  .name("pampalo")
  .description("Headless Pampalo agent account CLI")
  .version("0.0.0");

type CommonOpts = {
  account: string;
  chain: string;
  rpc?: string;
  passphrase?: string;
  json?: boolean;
};

const common = (cmd: Command): Command =>
  cmd
    .option("-a, --account <name>", "account name", "default")
    .option("-c, --chain <id>", "chain id", "84532")
    .option("--rpc <url>", "RPC URL (else PAMPALO_RPC / ALCHEMY_API_KEY)")
    .option("-p, --passphrase <s>", "keystore passphrase (else prompt / env)")
    .option("--json", "machine-readable output");

const chainOf = (o: CommonOpts): number => Number(o.chain);

/** Unlock the account: PAMPALO_MNEMONIC (ephemeral) or the keystore. */
async function load(o: CommonOpts): Promise<Account> {
  if (process.env.PAMPALO_MNEMONIC) {
    return Account.fromMnemonic(process.env.PAMPALO_MNEMONIC, o.account);
  }
  const passphrase = await getPassphrase(o.passphrase);
  return Account.load({ name: o.account, passphrase });
}

function printAddresses(a: Account, json?: boolean): void {
  out(
    !!json,
    () => {
      console.log("  evm             ", a.addresses.evm);
      console.log("  poseidon        ", a.addresses.poseidon);
      console.log("  envelope        ", a.addresses.envelope);
      console.log("  envelopeIsolated", a.addresses.envelopeIsolated);
    },
    { account: a.name, ...a.addresses },
  );
}

function resolveAsset(
  chainId: number,
  asset: string | undefined,
): { address?: string; decimals: number; symbol: string } {
  if (!asset || asset.toLowerCase() === "native" || asset.toLowerCase() === ETH_SENTINEL.toLowerCase()) {
    return { decimals: 18, symbol: "ETH" };
  }
  const tokens = DEPLOYMENTS[chainId]?.tokens ?? [];
  const hit = tokens.find(
    (t) =>
      t.address.toLowerCase() === asset.toLowerCase() ||
      t.symbol.toLowerCase() === asset.toLowerCase(),
  );
  if (hit) return { address: hit.address, decimals: hit.decimals, symbol: hit.symbol };
  // Unknown token address — caller must accept base-unit amounts.
  if (/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    return { address: asset, decimals: 0, symbol: asset.slice(0, 8) };
  }
  fail(`unknown asset "${asset}" — pass a token address or a known symbol`);
}

function amountFor(asset: { decimals: number }, human: string): bigint {
  if (asset.decimals === 0 && !/^\d+$/.test(human)) {
    fail("unknown token decimals — pass --amount in base units (integer)");
  }
  return parseAmount(human, asset.decimals);
}

// ── init ─────────────────────────────────────────────────────────────────
common(
  program
    .command("init [name]")
    .description("create a fresh agent account (new identity + keystore)"),
).action(async (name: string | undefined, o: CommonOpts) => {
  const account = name ?? o.account;
  const passphrase = await getPassphrase(o.passphrase, true);
  const a = await Account.create({ name: account, passphrase });
  console.log(`created account "${account}" (fresh identity)\n`);
  printAddresses(a, o.json);
  if (!o.json) console.log(`\nkeystore: ~/.pampalo/accounts/${account}.json`);
});

// ── import ───────────────────────────────────────────────────────────────
common(
  program
    .command("import [name]")
    .description("import an existing recovery phrase into a new keystore"),
).action(async (name: string | undefined, o: CommonOpts) => {
  const account = name ?? o.account;
  const mnemonic =
    process.env.PAMPALO_MNEMONIC ?? (await promptSecret("Recovery phrase: "));
  const passphrase = await getPassphrase(o.passphrase, true);
  const a = await Account.import({ name: account, passphrase, mnemonic });
  console.log(`imported account "${account}"\n`);
  printAddresses(a, o.json);
});

// ── address ──────────────────────────────────────────────────────────────
common(
  program.command("address [name]").description("show derived addresses"),
).action(async (name: string | undefined, o: CommonOpts) => {
  const a = await load({ ...o, account: name ?? o.account });
  printAddresses(a, o.json);
});

// ── balance ──────────────────────────────────────────────────────────────
common(
  program
    .command("balance")
    .description("public + private balances and shield statuses"),
).action(async (o: CommonOpts) => {
  const chainId = chainOf(o);
  const a = (await load(o)).useRpc({ [chainId]: resolveRpc(chainId, o.rpc) }).useStore();
  const pub = await a.balance({ chainId });
  const priv = a.privateBalance({ chainId });
  const shields = a.shields({ chainId });

  out(
    !!o.json,
    () => {
      console.log(`account ${a.addresses.evm}  (chain ${chainId})\n`);
      console.log("PUBLIC");
      console.log(`  ETH   ${fmt(pub.native.wei, 18)}`);
      for (const t of pub.tokens) console.log(`  ${t.symbol.padEnd(5)} ${fmt(t.wei, t.decimals)}`);
      console.log("\nPRIVATE (spendable notes)");
      if (priv.byAsset.length === 0) console.log("  (none — run `pampalo sync`)");
      for (const b of priv.byAsset)
        console.log(`  ${(b.symbol ?? b.asset.slice(0, 8)).padEnd(5)} ${fmt(b.spendable, b.decimals)}`);
      console.log("\nSHIELDS");
      if (shields.length === 0) console.log("  (none)");
      for (const s of shields) {
        const tag =
          s.state === "spendable" ? "approved" : s.state === "queued" ? "pending" : s.state;
        console.log(`  ${s.leafCommitment.slice(0, 12)}…  ${fmt(s.amount, s.assetDecimals)}  [${tag}]`);
      }
    },
    { public: pub, private: priv, shields },
  );
});

// ── sync ─────────────────────────────────────────────────────────────────
common(
  program
    .command("sync")
    .description("scan the chain, rebuild notes + leaf set")
    .option("--from <block>", "override start block")
    .option("--to <block>", "cap end block")
    .option("--chunk <n>", "block window per getLogs", "500000"),
).action(
  async (o: CommonOpts & { from?: string; to?: string; chunk?: string }) => {
    const chainId = chainOf(o);
    const a = (await load(o)).useRpc({ [chainId]: resolveRpc(chainId, o.rpc) }).useStore();
    const r = await a.sync({
      chainId,
      fromBlock: o.from ? Number(o.from) : undefined,
      toBlock: o.to ? Number(o.to) : undefined,
      chunk: o.chunk ? Number(o.chunk) : undefined,
    });
    out(
      !!o.json,
      () =>
        console.log(
          `synced ${r.fromBlock}→${r.toBlock}: ${r.leavesIndexed} leaves, ${r.notesUpserted} notes, ${r.spentMarked} spent`,
        ),
      r,
    );
  },
);

// ── send (public EVM transfer) ────────────────────────────────────────────
common(
  program
    .command("send")
    .description("public EVM transfer (native or ERC-20)")
    .requiredOption("--to <address>", "recipient EVM address")
    .requiredOption("--amount <human>", "amount in human units (e.g. 1.5)")
    .option("--asset <addr|symbol|native>", "asset to send", "native"),
).action(
  async (o: CommonOpts & { to: string; amount: string; asset: string }) => {
    const chainId = chainOf(o);
    const asset = resolveAsset(chainId, o.asset);
    if (asset.decimals === 0 && !/^\d+$/.test(o.amount)) {
      fail("unknown token decimals — pass --amount in base units (integer)");
    }
    const a = (await load(o)).useRpc({ [chainId]: resolveRpc(chainId, o.rpc) });
    const { txHash } = await a.send({
      chainId,
      to: o.to,
      asset: asset.address,
      amount: parseAmount(o.amount, asset.decimals),
    });
    out(
      !!o.json,
      () => {
        console.log(`sent ${o.amount} ${asset.symbol} → ${o.to}`);
        console.log(`tx: ${txHash}`);
      },
      { txHash, to: o.to, amount: o.amount, asset: asset.symbol },
    );
  },
);

// ── shield (public → private, to self) ────────────────────────────────────
common(
  program
    .command("shield")
    .description("public → private note (to self)")
    .requiredOption("--amount <human>", "amount in human units")
    .option("--asset <addr|symbol|native>", "asset to shield", "native"),
).action(async (o: CommonOpts & { amount: string; asset: string }) => {
  const chainId = chainOf(o);
  const asset = resolveAsset(chainId, o.asset);
  const amount = amountFor(asset, o.amount);
  const a = (await load(o))
    .useRpc({ [chainId]: resolveRpc(chainId, o.rpc) })
    .useStore();
  const r = await a.shield({ chainId, asset: asset.address, amount });
  out(
    !!o.json,
    () => {
      console.log(`shielded ${o.amount} ${asset.symbol}`);
      console.log(`tx:   ${r.txHash}`);
      console.log(`leaf: ${r.leafCommitment}`);
      console.log("\nnote is queued during the shield wait — run `pampalo sync` after it unlocks");
    },
    r,
  );
});

// ── transfer (private → private) ───────────────────────────────────────────
common(
  program
    .command("transfer")
    .description("private note → private note")
    .requiredOption("--amount <human>", "amount in human units")
    .requiredOption("--poseidon <id>", "recipient Poseidon identifier")
    .requiredOption("--envelope <key>", "recipient envelope public key")
    .option("--asset <addr|symbol|native>", "asset", "native"),
).action(
  async (
    o: CommonOpts & {
      amount: string;
      poseidon: string;
      envelope: string;
      asset: string;
    },
  ) => {
    const chainId = chainOf(o);
    const asset = resolveAsset(chainId, o.asset);
    const a = (await load(o))
      .useRpc({ [chainId]: resolveRpc(chainId, o.rpc) })
      .useStore();
    const r = await a.transfer({
      chainId,
      to: { poseidon: o.poseidon, envelope: o.envelope },
      asset: asset.address,
      amount: amountFor(asset, o.amount),
    });
    out(
      !!o.json,
      () => {
        console.log(`transferred ${o.amount} ${asset.symbol} (private)`);
        console.log(`tx: ${r.txHash}`);
      },
      r,
    );
  },
);

// ── unshield (private → public payout) ─────────────────────────────────────
common(
  program
    .command("unshield")
    .description("private note → public ERC-20/native payout")
    .requiredOption("--amount <human>", "amount in human units")
    .option("--recipient <address>", "EVM payout address (default: self)")
    .option("--asset <addr|symbol|native>", "asset", "native"),
).action(
  async (
    o: CommonOpts & { amount: string; recipient?: string; asset: string },
  ) => {
    const chainId = chainOf(o);
    const asset = resolveAsset(chainId, o.asset);
    const a = (await load(o))
      .useRpc({ [chainId]: resolveRpc(chainId, o.rpc) })
      .useStore();
    const r = await a.unshield({
      chainId,
      asset: asset.address,
      amount: amountFor(asset, o.amount),
      recipient: o.recipient,
    });
    out(
      !!o.json,
      () => {
        console.log(
          `unshielded ${o.amount} ${asset.symbol} → ${o.recipient ?? a.addresses.evm}`,
        );
        console.log(`tx: ${r.txHash}`);
      },
      r,
    );
  },
);

program.parseAsync(process.argv).catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});

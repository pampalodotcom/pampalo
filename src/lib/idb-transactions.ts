// IDB store for sent-transaction receipts.
//
// Per TRANSACTION_STORAGE.md the source of truth lives on-device: we only
// keep the bare minimum we need to reconstruct what the user did from the
// public chain — `{ chainId, txHash, raw }`, where `raw` is the
// JSON-stringified transaction skeleton (to/value/data/decimals/symbol/…)
// the UI built when the user hit Confirm. Anything beyond that comes from
// re-querying the chain via the RPC proxy.
//
// One global record per browser profile (same single-user assumption as
// `idb-prefs.ts`). Records are keyed by `${chainId}:${txHash}` so a single
// hash can't double-write on the same chain, but the same hash on another
// chain (e.g. dev-environment replay) is still allowed.

import { get, set, del } from "idb-keyval";

const KEY = "pampalo:transactions:v1";

export type StoredTransaction = {
  chainId: number;
  txHash: string;
  /** Wall-clock when the user submitted, ms. Lets us order without
   *  re-querying the chain on every render. */
  submittedAt: number;
  /** `JSON.stringify` of the barebones the UI needs to render this row
   *  without a chain fetch: kind, token symbol/address/decimals,
   *  amount (wei string), from, to, etc. Schema is intentionally loose
   *  — the UI shape can evolve without an IDB migration. */
  raw: string;
};

type Record = {
  transactions: StoredTransaction[];
};

async function read(): Promise<Record> {
  const rec = await get<Record>(KEY);
  if (!rec) return { transactions: [] };
  return rec;
}

async function write(rec: Record): Promise<void> {
  await set(KEY, rec);
}

export async function listTransactions(): Promise<StoredTransaction[]> {
  const rec = await read();
  // Newest-first so the UI just maps over the array.
  return rec.transactions.slice().sort((a, b) => b.submittedAt - a.submittedAt);
}

export async function listTransactionsForChain(
  chainId: number,
): Promise<StoredTransaction[]> {
  const all = await listTransactions();
  return all.filter((t) => t.chainId === chainId);
}

export async function appendTransaction(tx: StoredTransaction): Promise<void> {
  const rec = await read();
  // Dedupe by composite key. A re-submit of the same hash on the same
  // chain replaces the existing row so submittedAt advances.
  const key = `${tx.chainId}:${tx.txHash.toLowerCase()}`;
  const filtered = rec.transactions.filter(
    (t) => `${t.chainId}:${t.txHash.toLowerCase()}` !== key,
  );
  filtered.push(tx);
  await write({ transactions: filtered });
}

export async function clearTransactions(): Promise<void> {
  await del(KEY);
}

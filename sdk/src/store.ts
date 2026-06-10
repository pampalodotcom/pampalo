// SQLite note store for agent accounts (better-sqlite3).
//
// One database file holds three tables:
//   notes        — this device's notes, per-account (mirrors the web app's
//                  StoredNote). Private data, but the device is trusted
//                  (AUTH.md §1); the secret column never leaves here.
//   leaves       — every protocol leaf (public), keyed globally by
//                  (chainId, deployment, leafIndex). The merkle tree is
//                  rebuilt from this for proofs. Shared across accounts.
//   sync_cursors — per (account, chainId, deployment) last-scanned block.
//
// amounts / commitments / secrets are uint256-scale, stored as TEXT
// decimal/hex strings (SQLite INTEGER is only 64-bit).

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export type NoteState =
  | "queued"
  | "spendable"
  | "spent"
  | "cancelled"
  | "contested";
export type NoteOrigin = "shield" | "transferIn" | "change";

export type StoredNote = {
  /** Owning account — lowercased EVM address. */
  account: string;
  chainId: number;
  /** Lowercased Pampalo deployment address. */
  deployment: string;
  /** 0x + 64 hex. Primary key within an account. */
  leafCommitment: string;
  asset: string;
  assetDecimals: number;
  /** Base units, decimal string. */
  amount: string;
  /** Poseidon identifier (0x + 64 hex). */
  owner: string;
  secret: string;
  origin: NoteOrigin;
  state: NoteState;
  unlockTime?: number;
  queuedTxHash?: string;
  treeIndex?: number;
  leafIndex?: number;
  nullifier?: string;
  spentTxHash?: string;
};

export type NoteFilter = {
  account: string;
  chainId?: number;
  asset?: string;
  state?: NoteState;
};

export function defaultDbPath(): string {
  return join(homedir(), ".pampalo", "pampalo.db");
}

// Columns that may be patched on a note, with their StoredNote keys.
const PATCHABLE = [
  "state",
  "unlockTime",
  "queuedTxHash",
  "treeIndex",
  "leafIndex",
  "nullifier",
  "spentTxHash",
] as const;
type Patchable = (typeof PATCHABLE)[number];

export class Store {
  readonly #db: Database.Database;

  constructor(path: string = defaultDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        account        TEXT NOT NULL,
        chainId        INTEGER NOT NULL,
        deployment     TEXT NOT NULL,
        leafCommitment TEXT NOT NULL,
        asset          TEXT NOT NULL,
        assetDecimals  INTEGER NOT NULL,
        amount         TEXT NOT NULL,
        owner          TEXT NOT NULL,
        secret         TEXT NOT NULL,
        origin         TEXT NOT NULL,
        state          TEXT NOT NULL,
        unlockTime     INTEGER,
        queuedTxHash   TEXT,
        treeIndex      INTEGER,
        leafIndex      INTEGER,
        nullifier      TEXT,
        spentTxHash    TEXT,
        PRIMARY KEY (account, leafCommitment)
      );
      CREATE INDEX IF NOT EXISTS notes_by_account_state
        ON notes (account, chainId, state);

      CREATE TABLE IF NOT EXISTS leaves (
        chainId    INTEGER NOT NULL,
        deployment TEXT NOT NULL,
        leafIndex  INTEGER NOT NULL,
        commitment TEXT NOT NULL,
        PRIMARY KEY (chainId, deployment, leafIndex)
      );

      CREATE TABLE IF NOT EXISTS sync_cursors (
        account    TEXT NOT NULL,
        chainId    INTEGER NOT NULL,
        deployment TEXT NOT NULL,
        lastBlock  INTEGER NOT NULL,
        PRIMARY KEY (account, chainId, deployment)
      );
    `);
  }

  // ── Notes ─────────────────────────────────────────────────────────────

  /** Insert or merge a note. Idempotent on (account, leafCommitment): an
   *  existing row's provided columns are overwritten, the rest preserved. */
  upsertNote(note: StoredNote): void {
    this.#db
      .prepare(
        `INSERT INTO notes
           (account, chainId, deployment, leafCommitment, asset, assetDecimals,
            amount, owner, secret, origin, state, unlockTime, queuedTxHash,
            treeIndex, leafIndex, nullifier, spentTxHash)
         VALUES
           (@account, @chainId, @deployment, @leafCommitment, @asset, @assetDecimals,
            @amount, @owner, @secret, @origin, @state, @unlockTime, @queuedTxHash,
            @treeIndex, @leafIndex, @nullifier, @spentTxHash)
         ON CONFLICT(account, leafCommitment) DO UPDATE SET
            chainId=excluded.chainId, deployment=excluded.deployment,
            asset=excluded.asset, assetDecimals=excluded.assetDecimals,
            amount=excluded.amount, owner=excluded.owner, secret=excluded.secret,
            origin=excluded.origin, state=excluded.state,
            unlockTime=excluded.unlockTime, queuedTxHash=excluded.queuedTxHash,
            treeIndex=excluded.treeIndex, leafIndex=excluded.leafIndex,
            nullifier=excluded.nullifier, spentTxHash=excluded.spentTxHash`,
      )
      .run(toBind(note));
  }

  getNote(account: string, leafCommitment: string): StoredNote | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM notes WHERE account = ? AND leafCommitment = ?`)
      .get(account.toLowerCase(), leafCommitment.toLowerCase()) as
      | StoredNote
      | undefined;
    return row;
  }

  listNotes(filter: NoteFilter): StoredNote[] {
    const where: string[] = ["account = @account"];
    const params: Record<string, unknown> = {
      account: filter.account.toLowerCase(),
    };
    if (filter.chainId !== undefined) {
      where.push("chainId = @chainId");
      params.chainId = filter.chainId;
    }
    if (filter.asset !== undefined) {
      where.push("asset = @asset");
      params.asset = filter.asset.toLowerCase();
    }
    if (filter.state !== undefined) {
      where.push("state = @state");
      params.state = filter.state;
    }
    return this.#db
      .prepare(`SELECT * FROM notes WHERE ${where.join(" AND ")}`)
      .all(params) as StoredNote[];
  }

  /** Patch lifecycle fields on a note. Returns true if a row was updated. */
  patchNote(
    account: string,
    leafCommitment: string,
    patch: Partial<Pick<StoredNote, Patchable>>,
  ): boolean {
    const keys = PATCHABLE.filter((k) => k in patch);
    if (keys.length === 0) return false;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    const params: Record<string, unknown> = {
      account: account.toLowerCase(),
      leafCommitment: leafCommitment.toLowerCase(),
    };
    for (const k of keys) params[k] = patch[k] ?? null;
    const info = this.#db
      .prepare(
        `UPDATE notes SET ${set}
         WHERE account = @account AND leafCommitment = @leafCommitment`,
      )
      .run(params);
    return info.changes > 0;
  }

  /** Sum of spendable note amounts (base units) for the filter. */
  sumSpendable(filter: {
    account: string;
    chainId?: number;
    asset?: string;
  }): bigint {
    const rows = this.listNotes({ ...filter, state: "spendable" });
    let sum = 0n;
    for (const n of rows) sum += BigInt(n.amount);
    return sum;
  }

  // ── Leaves (global merkle tree mirror) ───────────────────────────────

  insertLeaf(
    chainId: number,
    deployment: string,
    leafIndex: number,
    commitment: string,
  ): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO leaves (chainId, deployment, leafIndex, commitment)
         VALUES (?, ?, ?, ?)`,
      )
      .run(chainId, deployment.toLowerCase(), leafIndex, commitment.toLowerCase());
  }

  /** All leaves for a deployment, ascending by index — feed into a
   *  PoseidonMerkleTree to rebuild the tree. */
  listLeaves(
    chainId: number,
    deployment: string,
  ): Array<{ leafIndex: number; commitment: string }> {
    return this.#db
      .prepare(
        `SELECT leafIndex, commitment FROM leaves
         WHERE chainId = ? AND deployment = ? ORDER BY leafIndex ASC`,
      )
      .all(chainId, deployment.toLowerCase()) as Array<{
      leafIndex: number;
      commitment: string;
    }>;
  }

  // ── Sync cursors ─────────────────────────────────────────────────────

  getCursor(account: string, chainId: number, deployment: string): number | null {
    const row = this.#db
      .prepare(
        `SELECT lastBlock FROM sync_cursors
         WHERE account = ? AND chainId = ? AND deployment = ?`,
      )
      .get(account.toLowerCase(), chainId, deployment.toLowerCase()) as
      | { lastBlock: number }
      | undefined;
    return row?.lastBlock ?? null;
  }

  setCursor(
    account: string,
    chainId: number,
    deployment: string,
    lastBlock: number,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO sync_cursors (account, chainId, deployment, lastBlock)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account, chainId, deployment)
           DO UPDATE SET lastBlock = excluded.lastBlock`,
      )
      .run(account.toLowerCase(), chainId, deployment.toLowerCase(), lastBlock);
  }

  close(): void {
    this.#db.close();
  }
}

// Bind record for upsert. Lowercases hex columns and coerces every
// optional to null — better-sqlite3 throws on an `undefined` bind.
function toBind(note: StoredNote): Record<string, string | number | null> {
  return {
    account: note.account.toLowerCase(),
    chainId: note.chainId,
    deployment: note.deployment.toLowerCase(),
    leafCommitment: note.leafCommitment.toLowerCase(),
    asset: note.asset.toLowerCase(),
    assetDecimals: note.assetDecimals,
    amount: note.amount,
    owner: note.owner.toLowerCase(),
    secret: note.secret.toLowerCase(),
    origin: note.origin,
    state: note.state,
    unlockTime: note.unlockTime ?? null,
    queuedTxHash: note.queuedTxHash?.toLowerCase() ?? null,
    treeIndex: note.treeIndex ?? null,
    leafIndex: note.leafIndex ?? null,
    nullifier: note.nullifier?.toLowerCase() ?? null,
    spentTxHash: note.spentTxHash?.toLowerCase() ?? null,
  };
}

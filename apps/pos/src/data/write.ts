import {
  type LedgerTable,
  MAX_OPS_PER_TX,
  type MasterTable,
  newId,
  type OpRow,
  opRow,
} from '@bikri/core';
import type {
  BikriDb,
  DexieTableName,
  MasterRow,
  OutboxEntry,
  SyncedRow,
} from '@bikri/db';
import type { Table, Transaction } from 'dexie';
import { applyLedgerEntry, applyStockMovement } from './caches.ts';

export class TooManyOpsError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(
      `one action may write at most ${MAX_OPS_PER_TX} ops (tried ${count})`,
    );
    this.name = 'TooManyOpsError';
    this.count = count;
  }
}

export class RowNotFoundError extends Error {
  readonly tbl: string;
  readonly id: string;
  constructor(tbl: string, id: string) {
    super(`${tbl} ${id} not found`);
    this.name = 'RowNotFoundError';
    this.tbl = tbl;
    this.id = id;
  }
}

export type NewMasterRow = OpRow & { id?: string };

/** Writes available inside one user action. Everything lands in one Dexie transaction. */
export interface Writer {
  readonly db: BikriDb;
  readonly txId: string;
  readonly now: number;
  /** New ops queued so far in this action (coalesced edits do not count). */
  readonly opCount: number;
  /**
   * A table bound to this action's transaction. Read through this (not `db.x`) inside the
   * action: after a native `await` Dexie may lose its zone, and `db.x` would then run
   * outside the transaction.
   */
  table<T = SyncedRow, K = string>(name: DexieTableName): Table<T, K>;
  /** Ledger row: stored, queued as an insert op, caches updated. */
  insert(tbl: LedgerTable, row: SyncedRow): Promise<SyncedRow>;
  /** New master row (base_rev 0, changed_fields []). */
  create(tbl: MasterTable, row: NewMasterRow): Promise<MasterRow>;
  /** Edit a master row; only fields that really change are sent as changed_fields. */
  update(tbl: MasterTable, id: string, patch: OpRow): Promise<MasterRow>;
  /** Soft delete (deleted_at) of a master row. */
  remove(tbl: MasterTable, id: string): Promise<void>;
}

export type WriteOptions = { now?: number; actor?: string | null };

const SYSTEM_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'updated_by',
  'rev',
  'deleted_at',
]);

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Runs one user action (03 §3): every row it writes and every op it queues are committed
 * together or not at all, and all ops share one tx_id. Pending edits of the same master row
 * are coalesced into the older op. More than MAX_OPS_PER_TX new ops aborts the action.
 */
export async function writeAction<T>(
  db: BikriDb,
  fn: (w: Writer) => Promise<T>,
  options: WriteOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now();
  const actor = options.actor ?? null;
  const txId = newId(now);
  let opCount = 0;

  const run = (tx: Transaction): Promise<T> => {
    const outbox = tx.table('outbox') as Table<OutboxEntry, number>;
    const queue = async (
      entry: Omit<
        OutboxEntry,
        'op_id' | 'tx_id' | 'created_at' | 'status' | 'attempts'
      >,
    ) => {
      opCount += 1;
      if (opCount > MAX_OPS_PER_TX) throw new TooManyOpsError(opCount);
      await outbox.add({
        ...entry,
        op_id: newId(now),
        tx_id: txId,
        created_at: now,
        status: 'pending',
        attempts: 0,
      });
    };

    const pendingUpsert = async (tbl: MasterTable, id: string) => {
      const entries = await outbox
        .where('[tbl+row_id]')
        .equals([tbl, id])
        .toArray();
      const last = entries.at(-1);
      return last && last.kind === 'upsert' && last.status === 'pending'
        ? last
        : undefined;
    };

    const master = (tbl: MasterTable) =>
      tx.table(tbl) as Table<MasterRow, string>;

    const writer: Writer = {
      db,
      txId,
      now,
      get opCount() {
        return opCount;
      },
      table<R = SyncedRow, K = string>(name: DexieTableName) {
        return tx.table(name) as Table<R, K>;
      },
      async insert(tbl, row) {
        await tx.table(tbl).add(row);
        await queue({
          tbl,
          kind: 'insert',
          row_id: row.id,
          row: opRow(tbl, row),
        });
        if (tbl === 'stock_movements') await applyStockMovement(tx, row);
        if (tbl === 'ledger_entries') await applyLedgerEntry(tx, row);
        return row;
      },
      async create(tbl, input) {
        const row: MasterRow = {
          ...input,
          id: input.id ?? newId(now),
          created_at: now,
          updated_at: now,
          updated_by: actor,
          deleted_at: null,
          rev: 0,
        };
        await master(tbl).add(row);
        await queue({
          tbl,
          kind: 'upsert',
          row_id: row.id,
          row: opRow(tbl, row),
          base_rev: 0,
          changed_fields: [],
        });
        return row;
      },
      async update(tbl, id, patch) {
        const existing = await master(tbl).get(id);
        if (!existing) throw new RowNotFoundError(tbl, id);
        const changed = Object.keys(patch).filter(
          (k) => !SYSTEM_FIELDS.has(k) && !sameValue(existing[k], patch[k]),
        );
        if (changed.length === 0) return existing;
        const row: MasterRow = {
          ...existing,
          ...patch,
          id,
          updated_at: now,
          updated_by: actor,
        };
        for (const k of SYSTEM_FIELDS)
          if (k !== 'updated_at' && k !== 'updated_by') row[k] = existing[k];
        await master(tbl).put(row);
        const pending = await pendingUpsert(tbl, id);
        if (pending?.seq !== undefined) {
          const creating = pending.base_rev === 0;
          const fields = creating
            ? []
            : [...new Set([...(pending.changed_fields ?? []), ...changed])];
          await outbox.update(pending.seq, {
            row: opRow(tbl, row),
            changed_fields: fields,
          });
        } else {
          await queue({
            tbl,
            kind: 'upsert',
            row_id: id,
            row: opRow(tbl, row),
            base_rev: existing.rev,
            changed_fields: changed,
          });
        }
        return row;
      },
      async remove(tbl, id) {
        const existing = await master(tbl).get(id);
        if (!existing) throw new RowNotFoundError(tbl, id);
        if (existing.deleted_at) return;
        await master(tbl).put({
          ...existing,
          deleted_at: now,
          updated_at: now,
          updated_by: actor,
        });
        await queue({
          tbl,
          kind: 'delete',
          row_id: id,
          base_rev: existing.rev,
        });
      },
    };

    return fn(writer);
  };

  return db.transaction('rw', db.tables, run);
}

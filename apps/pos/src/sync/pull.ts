/** Pull, snapshot and restore recovery (03 §4.2–4.3). */
import {
  type LedgerTable,
  MASTER_TABLES,
  MAX_OPS_PER_TX,
  type MasterTable,
  newId,
  opRow,
  SYNC_IMPORT_ORDER,
} from '@bikri/core';
import type { BikriDb, SyncedRow } from '@bikri/db';
import { rebuildCaches } from '../data/caches.ts';
import { getKv, setKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { SyncHttpError, tillRequest } from './client.ts';
import { mergeRows, mergeScope, type ServerRow } from './merge.ts';
import { applyStatus, type StatusPayload } from './status.ts';
import { isLedgerTable, PULLED_TABLES } from './tables.ts';

type PullResponse = {
  changes: {
    seq: number;
    tbl: string;
    op: 'upsert' | 'delete';
    row: SyncedRow;
  }[];
  next_since: number;
  has_more: boolean;
  server_time: number;
  restore_epoch: string;
  restore_point_at: number;
} & StatusPayload;

export type Progress = (done: number, total: number) => void;

export type SnapshotState = {
  seq: number;
  tables: { tbl: string; rows: number }[];
  index: number;
  after: string;
  done: number;
};

/** Pulls until has_more is false. Returns the server time of the last page. */
export async function pullAll(
  db: BikriDb,
  onSnapshot?: Progress,
): Promise<number | null> {
  if (await getKv<SnapshotState | null>(db, 'snapshot_state', null)) {
    await runSnapshot(db, onSnapshot);
  }
  let serverTime: number | null = null;
  for (let page = 0; page < 200; page += 1) {
    const since = await getKv<number>(db, 'pull_cursor', 0);
    let res: PullResponse;
    try {
      res = await tillRequest<PullResponse>(
        db,
        `/sync/pull?since=${since}&limit=500`,
      );
    } catch (e) {
      if (e instanceof SyncHttpError && e.code === 'SNAPSHOT_REQUIRED') {
        await runSnapshot(db, onSnapshot);
        continue;
      }
      throw e;
    }
    serverTime = res.server_time;
    await applyStatus(db, res);
    const epoch = await getKv<string | null>(db, 'restore_epoch', null);
    if (epoch === null) {
      await setKv(db, 'restore_epoch', res.restore_epoch);
    } else if (epoch !== res.restore_epoch) {
      await restoreRecovery(
        db,
        res.restore_point_at,
        res.restore_epoch,
        onSnapshot,
      );
      continue;
    }
    await applyPage(
      db,
      res.changes.map((c) => ({ tbl: c.tbl, row: c.row })),
      res.next_since,
    );
    if (!res.has_more) break;
  }
  return serverTime;
}

/**
 * Applies one pull page. If one malformed row aborts the page, retry row-by-row, quarantine the
 * bad rows under kv.pull_errors and advance the cursor so sync can continue.
 */
/** Only a row-shaped error is quarantined; storage/abort errors must keep the cursor. */
function isRowError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'DataError' ||
      error.name === 'SchemaError' ||
      error.name === 'ZodError' ||
      error.name === 'ConstraintError' ||
      error.name === 'BulkError' ||
      error.name === 'PullRowError')
  );
}

async function applyPage(
  db: BikriDb,
  rows: ServerRow[],
  nextSince: number,
): Promise<void> {
  const tbls = new Set(rows.map((row) => row.tbl));
  try {
    await db.transaction('rw', mergeScope(tbls), async (tx) => {
      await mergeRows(tx, rows, { caches: true });
      await tx.table('kv').put({ key: 'pull_cursor', value: nextSince });
      await tx.table('kv').put({ key: 'last_pull_at', value: Date.now() });
    });
    return;
  } catch (error) {
    if (!isRowError(error)) throw error;
  }
  const errors: { tbl: string; id: string; message: string; at: number }[] = [];
  for (const row of rows) {
    try {
      await db.transaction('rw', mergeScope([row.tbl]), async (tx) => {
        await mergeRows(tx, [row], { caches: true });
      });
    } catch (error) {
      if (!isRowError(error)) throw error;
      errors.push({
        tbl: row.tbl,
        id: String(row.row.id ?? ''),
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
    }
  }
  await db.transaction('rw', ['kv'], async (tx) => {
    const stored = (await tx.table('kv').get('pull_errors')) as
      | { value?: typeof errors }
      | undefined;
    await tx.table('kv').put({
      key: 'pull_errors',
      value: [...(stored?.value ?? []), ...errors].slice(-50),
    });
    await tx.table('kv').put({ key: 'pull_cursor', value: nextSince });
    await tx.table('kv').put({ key: 'last_pull_at', value: Date.now() });
  });
}

/**
 * Resumable snapshot (kv.snapshot_state). Rows go through the same merge as a pull, so pending
 * local edits survive; caches are rebuilt at the end; then the pull continues from snapshot_seq.
 */
export async function runSnapshot(
  db: BikriDb,
  onProgress?: Progress,
): Promise<void> {
  let state = await getKv<SnapshotState | null>(db, 'snapshot_state', null);
  if (!state) {
    const start = await tillRequest<{
      snapshot_seq: number;
      tables: { tbl: string; rows: number }[];
    }>(db, '/sync/snapshot');
    state = {
      seq: start.snapshot_seq,
      tables: start.tables,
      index: 0,
      after: '',
      done: 0,
    };
    await setKv(db, 'snapshot_state', state);
  }
  const total = state.tables.reduce((s, t) => s + t.rows, 0);
  onProgress?.(state.done, total);
  while (state.index < state.tables.length) {
    const tbl = state.tables[state.index]?.tbl ?? '';
    const page = await tillRequest<{
      rows: SyncedRow[];
      next_after: string;
      has_more: boolean;
    }>(
      db,
      `/sync/snapshot?tbl=${encodeURIComponent(tbl)}&after=${encodeURIComponent(state.after)}&limit=500`,
    );
    const next: SnapshotState = page.has_more
      ? {
          ...state,
          after: page.next_after,
          done: state.done + page.rows.length,
        }
      : {
          ...state,
          index: state.index + 1,
          after: '',
          done: state.done + page.rows.length,
        };
    await db.transaction('rw', mergeScope([tbl]), async (tx) => {
      await mergeRows(
        tx,
        page.rows.map((row) => ({ tbl, row })),
        { caches: false },
      );
      await tx.table('kv').put({ key: 'snapshot_state', value: next });
    });
    state = next;
    onProgress?.(state.done, total);
  }
  await rebuildCaches(db);
  await db.transaction('rw', db.kv, async () => {
    await setKv(db, 'pull_cursor', state.seq);
    await db.kv.delete('snapshot_state');
  });
  await fixInvoiceSeq(db);
}

/** Never lower the invoice counter (03 §4.2 step 3). */
export async function fixInvoiceSeq(db: BikriDb): Promise<void> {
  const device = await deviceInfo(db);
  if (!device) return;
  const own = await db.sales
    .where('[device_id+invoice_seq]')
    .between([device.id, 0], [device.id, Number.MAX_SAFE_INTEGER])
    .last();
  const server = Number(
    (await db.devices.get(device.id))?.last_invoice_seq ?? 0,
  );
  const current = await getKv<number>(db, 'invoice_seq', 0);
  const next = Math.max(current, Number(own?.invoice_seq ?? 0), server);
  if (next !== current) await setKv(db, 'invoice_seq', next);
}

/**
 * Restore recovery (03 §4.2): re-send own ledger rows created since the restore point as fresh
 * inserts, clear synced tables and caches (outbox kept), snapshot again.
 */
type RecoveredOp = { tbl: LedgerTable; row: SyncedRow };

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Rebuild coherent documents so a recovered transaction stays under the server's op cap. */
function recoveryGroups(rows: RecoveredOp[]): RecoveredOp[][] {
  const voidBySale = new Map<string, string>();
  for (const { tbl, row } of rows)
    if (tbl === 'sale_voids' && text(row.sale_id))
      voidBySale.set(text(row.sale_id), String(row.id));

  const paymentGroup = new Map<string, string>();
  for (const { tbl, row } of rows) {
    if (tbl !== 'payments') continue;
    const sale = text(row.sale_id);
    const refund = text(row.refund_id);
    const purchase = text(row.purchase_id);
    const sret = text(row.supplier_return_id);
    let key = `pay:${String(row.id)}`;
    if (sale && row.purpose === 'void')
      key = `void:${voidBySale.get(sale) ?? sale}`;
    else if (sale) key = `sale:${sale}`;
    else if (refund) key = `refund:${refund}`;
    else if (purchase) key = `purchase:${purchase}`;
    else if (sret) key = `sret:${sret}`;
    paymentGroup.set(String(row.id), key);
  }

  const groupOf = ({ tbl, row }: RecoveredOp): string => {
    switch (tbl) {
      case 'sales':
        return `sale:${String(row.id)}`;
      case 'sale_lines':
        return `sale:${text(row.sale_id)}`;
      case 'refunds':
        return `refund:${String(row.id)}`;
      case 'refund_lines':
        return `refund:${text(row.refund_id)}`;
      case 'purchases':
        return `purchase:${String(row.id)}`;
      case 'purchase_lines':
        return `purchase:${text(row.purchase_id)}`;
      case 'supplier_returns':
        return `sret:${String(row.id)}`;
      case 'supplier_return_lines':
        return `sret:${text(row.return_id)}`;
      case 'sale_voids':
        return `void:${String(row.id)}`;
      case 'payments':
        return paymentGroup.get(String(row.id)) ?? `pay:${String(row.id)}`;
      case 'expenses':
        return `expense:${String(row.id)}`;
      case 'audit_log': {
        const entity = text(row.entity);
        const id = text(row.entity_id);
        if (entity === 'sale_voids') return `void:${id}`;
        if (entity === 'refunds') return `refund:${id}`;
        if (entity === 'sales') return `sale:${id}`;
        if (entity === 'expenses') return `expense:${id}`;
        return `audit:${String(row.id)}`;
      }
      case 'ledger_entries': {
        const source = text(row.source_type);
        const id = text(row.source_id);
        if (source === 'sale') return `sale:${id}`;
        if (source === 'refund') return `refund:${id}`;
        if (source === 'void') return `void:${id}`;
        if (source === 'payment') return paymentGroup.get(id) ?? `pay:${id}`;
        if (source === 'purchase') return `purchase:${id}`;
        if (source === 'supplier_return') return `sret:${id}`;
        return `ledger:${String(row.id)}`;
      }
      case 'stock_movements': {
        const reason = text(row.reason_code);
        const id = text(row.ref_id);
        if (reason === 'sale') return `sale:${id}`;
        if (reason === 'refund_return') return `refund:${id}`;
        if (reason === 'void_return') return `void:${id}`;
        if (reason === 'purchase') return `purchase:${id}`;
        if (reason === 'supplier_return') return `sret:${id}`;
        return `movement:${String(row.id)}`;
      }
      default:
        return `row:${tbl}:${String(row.id)}`;
    }
  };

  const groups = new Map<string, RecoveredOp[]>();
  for (const item of rows) {
    const key = groupOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.values()];
}

type RecoveredMaster = { tbl: MasterTable; row: SyncedRow; deleted: boolean };
type OutboxDraft = {
  tbl: MasterTable | LedgerTable;
  kind: 'insert' | 'upsert' | 'delete';
  row_id: string;
  row?: Record<string, unknown>;
  base_rev?: number;
  changed_fields?: string[];
  updated_by?: string | null;
  created_at: number;
};

const MASTER_SET = new Set<string>(MASTER_TABLES);

function masterDraft(item: RecoveredMaster, now: number): OutboxDraft {
  const row = opRow(item.tbl, item.row);
  const baseRev = Number(item.row.rev ?? 0);
  if (item.deleted) {
    return {
      tbl: item.tbl,
      kind: 'delete',
      row_id: item.row.id,
      base_rev: baseRev,
      updated_by:
        typeof item.row.updated_by === 'string' ? item.row.updated_by : null,
      created_at: now,
    };
  }
  return {
    tbl: item.tbl,
    kind: 'upsert',
    row_id: item.row.id,
    row,
    base_rev: baseRev,
    changed_fields: Object.keys(row).filter((key) => key !== 'id'),
    updated_by:
      typeof item.row.updated_by === 'string' ? item.row.updated_by : null,
    created_at: now,
  };
}

function ledgerDraft(
  row: SyncedRow,
  tbl: LedgerTable,
  now: number,
): OutboxDraft {
  return {
    tbl,
    kind: 'insert',
    row_id: row.id,
    row: opRow(tbl, row),
    created_at: now,
  };
}

/** Staff rows that must be present in a transaction for its rows to pass the server checks. */
function staffRefs(row: SyncedRow | undefined): string[] {
  if (!row) return [];
  const out: string[] = [];
  for (const field of ['staff_id', 'updated_by']) {
    const value = row[field];
    if (typeof value === 'string') out.push(value);
  }
  return out;
}

/**
 * Restore recovery (03 §4.2): re-send own ledger rows created since the restore point as fresh
 * inserts, clear synced tables and caches (outbox kept), snapshot again. The snapshot state is
 * saved before clearing so a dropped connection resumes the download instead of leaving an
 * empty till. Recovered rows are grouped into document-sized transactions (≤ 200 ops).
 *
 * Master rows created/updated after the restore point are recovered too. The restored server
 * copy only contains rows that existed at the restore point; discarding a new customer,
 * product or staff member would make the recovered ledger rows fail their FKs or permissions.
 */
export async function restoreRecovery(
  db: BikriDb,
  restorePointAt: number,
  restoreEpoch: string,
  onProgress?: Progress,
): Promise<void> {
  const device = await deviceInfo(db);
  const now = Date.now();
  if (device) {
    const start = await tillRequest<{
      snapshot_seq: number;
      tables: { tbl: string; rows: number }[];
    }>(db, '/sync/snapshot');
    await setKv(db, 'snapshot_state', {
      seq: start.snapshot_seq,
      tables: start.tables,
      index: 0,
      after: '',
      done: 0,
    } satisfies SnapshotState);
  }
  try {
    await db.transaction('rw', db.tables, async () => {
      const recoveredRows: RecoveredOp[] = [];
      if (device) {
        const recovered = new Map<string, Set<string>>();
        const lineParents: Record<string, { table: string; field: string }> = {
          sale_lines: { table: 'sales', field: 'sale_id' },
          refund_lines: { table: 'refunds', field: 'refund_id' },
          purchase_lines: { table: 'purchases', field: 'purchase_id' },
          supplier_return_lines: {
            table: 'supplier_returns',
            field: 'return_id',
          },
        };
        for (const tbl of PULLED_TABLES) {
          if (!isLedgerTable(tbl)) continue;
          const rows = (await db.table(tbl).toArray()) as SyncedRow[];
          const parent = lineParents[tbl];
          for (const row of rows) {
            const mine = parent
              ? recovered.get(parent.table)?.has(String(row[parent.field])) ===
                true
              : row.device_id !== undefined && row.device_id === device.id;
            if (
              !mine ||
              (!parent && Number(row.created_at ?? 0) < restorePointAt)
            )
              continue;
            if (!parent) {
              const set = recovered.get(tbl) ?? new Set<string>();
              set.add(String(row.id));
              recovered.set(tbl, set);
            }
            recoveredRows.push({ tbl: tbl as LedgerTable, row });
          }
        }
      }
      // Master rows created or updated after the restore point are not in the restored
      // server copy. Re-send them first so recovered sales/payments/expenses have their
      // customer, product, category and staff references.
      const queued = new Set(
        (await db.outbox.toArray()).map(
          (entry) => `${entry.tbl}:${entry.row_id}`,
        ),
      );
      const masterRows: RecoveredMaster[] = [];
      for (const tbl of SYNC_IMPORT_ORDER) {
        if (!MASTER_SET.has(tbl)) continue;
        const rows = (await db
          .table(tbl as MasterTable)
          .toArray()) as SyncedRow[];
        for (const row of rows) {
          const created = Number(row.created_at ?? 0);
          const updated = Number(row.updated_at ?? 0);
          const deleted = row.deleted_at ? Number(row.deleted_at) : 0;
          if (Math.max(created, updated, deleted) < restorePointAt) continue;
          // Staff rows are included even when an outbox entry exists so a new cashier can
          // be placed in the same transaction as the rows they created. Other rows already
          // queued keep their original transaction.
          if (tbl !== 'staff' && queued.has(`${tbl}:${row.id}`)) continue;
          masterRows.push({
            tbl: tbl as MasterTable,
            row,
            deleted: row.deleted_at != null,
          });
        }
      }

      const openingRows = recoveredRows.filter(
        ({ row }) => row.source_type === 'opening',
      );
      const openingKeys = new Set<string>();
      for (const { row } of openingRows) {
        const partyTable =
          row.party_type === 'customer' ? 'customers' : 'suppliers';
        const partyId = String(row.party_id);
        openingKeys.add(`${partyTable}:${partyId}`);
        if (
          masterRows.some(
            (item) => item.tbl === partyTable && item.row.id === partyId,
          )
        )
          continue;
        const party = (await db
          .table(partyTable as 'customers' | 'suppliers')
          .get(partyId)) as SyncedRow | undefined;
        if (party)
          masterRows.push({
            tbl: partyTable,
            row: party,
            deleted: party.deleted_at != null,
          });
      }

      const newStaff = new Map(
        masterRows
          .filter((item) => item.tbl === 'staff')
          .map((item) => [item.row.id, item] as const),
      );
      // A transaction is built from whole units. A unit is one document (sale + lines +
      // payment + ledger, an opening balance with its party, …) or one master row, so the
      // Worker's in-group checks keep seeing the rows together. Units are packed up to the
      // op limit; a new staff row is copied into every transaction whose rows reference it
      // because the Worker plans the whole push against the state before the push.
      const units: { drafts: OutboxDraft[]; staff: Set<string> }[] = [];
      const referencedStaff = new Set<string>();
      const addUnit = (
        drafts: OutboxDraft[],
        rows: (SyncedRow | undefined)[],
      ) => {
        const staff = new Set<string>();
        for (const row of rows) {
          for (const id of staffRefs(row)) {
            if (!newStaff.has(id)) continue;
            staff.add(id);
            referencedStaff.add(id);
          }
        }
        units.push({ drafts, staff });
      };

      // An opening balance needs its party row in the same transaction: the Worker's
      // opening check accepts only a party in the same op group.
      for (const { row } of openingRows) {
        const partyTable =
          row.party_type === 'customer' ? 'customers' : 'suppliers';
        const party = masterRows.find(
          (item) =>
            item.tbl === partyTable && item.row.id === String(row.party_id),
        );
        const drafts = party ? [masterDraft(party, now)] : [];
        drafts.push(ledgerDraft(row, 'ledger_entries', now));
        addUnit(drafts, [party?.row, row]);
      }

      for (const item of masterRows) {
        if (item.tbl === 'staff') continue;
        if (openingKeys.has(`${item.tbl}:${item.row.id}`)) continue;
        addUnit([masterDraft(item, now)], [item.row]);
      }

      const otherLedger = recoveredRows.filter(
        ({ row }) => row.source_type !== 'opening',
      );
      for (const group of recoveryGroups(otherLedger)) {
        addUnit(
          group.map(({ tbl, row }) => ledgerDraft(row, tbl, now)),
          group.map(({ row }) => row),
        );
      }

      // A new staff member with no rows of their own still has to be restored.
      for (const item of newStaff.values()) {
        if (referencedStaff.has(item.row.id)) continue;
        addUnit([masterDraft(item, now)], [item.row]);
      }

      const chunks: OutboxDraft[][] = [];
      let chunk: OutboxDraft[] = [];
      let chunkStaff = new Set<string>();
      const flush = () => {
        if (chunk.length === 0) return;
        chunks.push(chunk);
        chunk = [];
        chunkStaff = new Set<string>();
      };
      for (const unit of units) {
        const extra = [...unit.staff].filter((id) => !chunkStaff.has(id));
        if (
          chunk.length > 0 &&
          chunk.length + unit.drafts.length + extra.length > MAX_OPS_PER_TX
        )
          flush();
        for (const id of unit.staff) {
          if (chunkStaff.has(id)) continue;
          chunkStaff.add(id);
          const staff = newStaff.get(id);
          if (staff) chunk.push(masterDraft(staff, now));
        }
        chunk.push(...unit.drafts);
      }
      flush();

      for (const drafts of chunks) {
        const txId = newId(now);
        for (const draft of drafts) {
          await db.outbox.add({
            op_id: newId(now),
            tx_id: txId,
            ...draft,
            status: 'pending',
            attempts: 0,
          });
        }
      }
      for (const tbl of PULLED_TABLES) await db.table(tbl).clear();
      await db.stock_levels.clear();
      await db.party_balances.clear();
      await db.pull_shadow.clear();
      await db.kv.put({ key: 'pull_cursor', value: 0 });
      await db.kv.put({ key: 'restore_epoch', value: restoreEpoch });
    });
  } catch (error) {
    await db.kv.delete('snapshot_state');
    throw error;
  }
  // Resumes the snapshot state saved before the clear, even if the previous attempt failed.
  await runSnapshot(db, onProgress);
}

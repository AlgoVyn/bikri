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
import {
  clearCatalogueSearchCache,
  clearInvoiceSearchCache,
} from '../data/search.ts';
import { clearSoldCache } from '../state/catalogue.ts';
import { SyncHttpError, tillAuth, tillRequest } from './client.ts';
import { withSyncLock } from './lock.ts';
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
  return withSyncLock(db, () => pullAllUnlocked(db, onSnapshot));
}

async function pullAllUnlocked(
  db: BikriDb,
  onSnapshot?: Progress,
): Promise<number | null> {
  if (await getKv<SnapshotState | null>(db, 'snapshot_state', null)) {
    await runSnapshotUnlocked(db, onSnapshot);
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
        await runSnapshotUnlocked(db, onSnapshot);
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
      await restoreRecoveryUnlocked(
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
  // One signal per completed pull, not one per page: Home's attention refresh and the
  // "last pull" card must not re-run while a 200-page backlog is still downloading.
  await setKv(db, 'last_pull_at', Date.now());
  await settleRecovery(db);
  return serverTime;
}

/** A pulled row can change what search and the 30-day "best sellers" cache return. */
const SOLD_SOURCE_TABLES = new Set([
  'sales',
  'sale_lines',
  'refunds',
  'refund_lines',
  'sale_voids',
]);
const SEARCH_CATALOGUE_TABLES = new Set([
  'products',
  'product_barcodes',
  'customers',
]);
const SEARCH_INVOICE_TABLES = new Set(['sales', 'refunds', 'sale_voids']);
function clearReaderCaches(tables: Iterable<string>): void {
  let sold = false;
  let catalogue = false;
  let invoice = false;
  for (const table of tables) {
    if (SOLD_SOURCE_TABLES.has(table)) sold = true;
    if (SEARCH_CATALOGUE_TABLES.has(table)) catalogue = true;
    if (SEARCH_INVOICE_TABLES.has(table)) invoice = true;
  }
  if (sold) clearSoldCache();
  if (catalogue) clearCatalogueSearchCache();
  if (invoice) clearInvoiceSearchCache();
}

/** Pulled rows that advance the derived caches (`stock_levels`, `party_balances`). */
const CACHE_TABLES = new Set(['stock_movements', 'ledger_entries']);

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

/**
 * A pulled `sale_voids` row collides with a local void for the same sale on the unique
 * `sale_id`: two tills voided the bill offline and the other till won on the server.
 * The server row is authoritative, so drop the whole losing local action (its void row,
 * reversal payments, ledger entries, stock movements and audits) together with its
 * outbox ops. Quarantining the server row instead would leave those local rows counted
 * in the caches and later discard them again as a duplicate refund/void.
 *
 * Returns true when a losing local transaction was removed; the caller can retry the
 * write and must rebuild the derived caches.
 */
async function dropLosingSaleVoid(
  db: BikriDb,
  row: SyncedRow,
): Promise<boolean> {
  const saleId = typeof row.sale_id === 'string' ? row.sale_id : '';
  if (saleId === '' || typeof row.id !== 'string' || row.id === '')
    return false;
  const local = (await db.sale_voids.where('sale_id').equals(saleId).first()) as
    | SyncedRow
    | undefined;
  if (!local || String(local.id) === row.id) return false;
  // Only a locally created void can lose: an already-serving server void has no outbox
  // op, and a duplicate server row for one sale is a malformed page, not this race.
  const claims = await db.outbox
    .where('[tbl+row_id]')
    .equals(['sale_voids', String(local.id)])
    .toArray();
  if (claims.length === 0) return false;
  const txIds = new Set(claims.map((entry) => String(entry.tx_id)));
  const losers = await db.outbox
    .filter((entry) => txIds.has(String(entry.tx_id)))
    .toArray();
  await db.transaction('rw', db.tables, async () => {
    for (const entry of losers) {
      await db.table(entry.tbl).delete(entry.row_id);
      await db.pull_shadow.delete([entry.tbl, entry.row_id]);
    }
    const seqs = losers
      .map((entry) => entry.seq)
      .filter((seq): seq is number => seq !== undefined);
    if (seqs.length > 0) await db.outbox.bulkDelete(seqs);
    // The void row itself can be missing from `losers` only if its op was coalesced
    // away; delete the stored row either way so the unique index is free.
    await db.sale_voids.delete(String(local.id));
    await db.pull_shadow.delete(['sale_voids', String(local.id)]);
  });
  return true;
}

/** True when the server row lost its write race with a local void of the same sale. */
function isSaleVoidCollision(tbl: string, error: unknown): boolean {
  return (
    tbl === 'sale_voids' &&
    error instanceof Error &&
    (error.name === 'ConstraintError' ||
      (error.name === 'BulkError' && /Unique|constraint/iu.test(error.message)))
  );
}

/**
 * Applies one pull page. If one malformed row aborts the page, retry row-by-row, quarantine the
 * bad rows under kv.pull_errors and advance the cursor so sync can continue.
 */
async function applyPage(
  db: BikriDb,
  rows: ServerRow[],
  nextSince: number,
): Promise<void> {
  const tbls = new Set(rows.map((row) => row.tbl));
  // Only movement/ledger rows touch the derived caches; a master-data page must not
  // lock the cache stores for nothing.
  const caches = rows.some((row) => CACHE_TABLES.has(row.tbl));
  try {
    await db.transaction('rw', mergeScope(tbls, caches), async (tx) => {
      await mergeRows(tx, rows, { caches });
      await tx.table('kv').put({ key: 'pull_cursor', value: nextSince });
    });
    clearReaderCaches(tbls);
    return;
  } catch (error) {
    if (!isRowError(error)) throw error;
  }
  const errors: { tbl: string; id: string; message: string; at: number }[] = [];
  for (const row of rows) {
    const rowCaches = CACHE_TABLES.has(row.tbl);
    try {
      await db.transaction(
        'rw',
        mergeScope([row.tbl], rowCaches),
        async (tx) => {
          await mergeRows(tx, [row], { caches: rowCaches });
        },
      );
    } catch (error) {
      if (!isRowError(error)) throw error;
      if (
        isSaleVoidCollision(row.tbl, error) &&
        (await dropLosingSaleVoid(db, row.row))
      ) {
        await rebuildCaches(db);
        try {
          await db.transaction(
            'rw',
            mergeScope([row.tbl], rowCaches),
            async (tx) => {
              await mergeRows(tx, [row], { caches: rowCaches });
            },
          );
          continue;
        } catch (retryError) {
          if (!isRowError(retryError)) throw retryError;
        }
      }
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
  });
  clearReaderCaches(tbls);
}

/**
 * Merge one snapshot page. A bad row is quarantined like a pull row and the page still
 * advances, so a single unique collision can never wedge initial sync forever. A
 * `sale_voids` collision means another till already voided the same sale: the server's
 * void is the winner, so the whole losing local void transaction is dropped first (see
 * `dropLosingSaleVoid`), then the server row is written.
 *
 * Caches stay untouched while a snapshot downloads: `runSnapshotUnlocked` rebuilds
 * `stock_levels` and `party_balances` from the full local tables once at the end.
 * Updating them on every page only to have that rebuild clear and rescan them was most
 * of the write traffic of a large enrolment.
 */
async function mergeSnapshotPage(
  db: BikriDb,
  tbl: string,
  rows: SyncedRow[],
  next: SnapshotState,
): Promise<void> {
  try {
    await db.transaction('rw', mergeScope([tbl]), async (tx) => {
      await mergeRows(
        tx,
        rows.map((row) => ({ tbl, row })),
        { caches: false },
      );
      await tx.table('kv').put({ key: 'snapshot_state', value: next });
    });
    clearReaderCaches([tbl]);
    return;
  } catch (error) {
    if (!isRowError(error)) throw error;
  }
  const errors: { tbl: string; id: string; message: string; at: number }[] = [];
  for (const row of rows) {
    try {
      await db.transaction('rw', mergeScope([tbl]), async (tx) => {
        await mergeRows(tx, [{ tbl, row }], { caches: false });
      });
    } catch (error) {
      if (!isRowError(error)) throw error;
      if (
        isSaleVoidCollision(tbl, error) &&
        (await dropLosingSaleVoid(db, row))
      ) {
        try {
          await db.transaction('rw', mergeScope([tbl]), async (tx) => {
            await mergeRows(tx, [{ tbl, row }], { caches: false });
          });
          continue;
        } catch (retryError) {
          if (!isRowError(retryError)) throw retryError;
        }
      }
      errors.push({
        tbl,
        id: String(row.id ?? ''),
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
    await tx.table('kv').put({ key: 'snapshot_state', value: next });
  });
  clearReaderCaches([tbl]);
}

/**
 * Resumable snapshot (kv.snapshot_state). Rows go through the same merge as a pull, so pending
 * local edits survive; caches are rebuilt at the end; then the pull continues from snapshot_seq.
 */
export async function runSnapshot(
  db: BikriDb,
  onProgress?: Progress,
): Promise<void> {
  return withSyncLock(db, () => runSnapshotUnlocked(db, onProgress));
}

async function runSnapshotUnlocked(
  db: BikriDb,
  onProgress?: Progress,
): Promise<void> {
  let state = await getKv<SnapshotState | null>(db, 'snapshot_state', null);
  let statusApplied = false;
  if (!state) {
    const start = await tillRequest<
      {
        snapshot_seq: number;
        tables: { tbl: string; rows: number }[];
      } & StatusPayload
    >(db, '/sync/snapshot');
    await applyStatus(db, start);
    statusApplied = true;
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
  type SnapshotPage = {
    rows: SyncedRow[];
    next_after: string;
    has_more: boolean;
  } & StatusPayload;
  // The token and pending header do not change between pages; reusing them keeps two
  // kv/outbox reads off every one of the ~2,500 pages and lets the prefetch start at once.
  const auth = await tillAuth(db);
  const fetchPage = (current: SnapshotState): Promise<SnapshotPage> => {
    const tbl = current.tables[current.index]?.tbl ?? '';
    return tillRequest<SnapshotPage>(
      db,
      `/sync/snapshot?tbl=${encodeURIComponent(tbl)}&after=${encodeURIComponent(current.after)}&limit=500`,
      auth ? { auth } : {},
    );
  };
  let pending: Promise<SnapshotPage> | null = null;
  while (state.index < state.tables.length) {
    const tbl = state.tables[state.index]?.tbl ?? '';
    const page = pending === null ? await fetchPage(state) : await pending;
    pending = null;
    // The start response already applied the status; refresh it once per run (a resumed
    // snapshot has no start response) instead of running three kv reads per page.
    if (!statusApplied) {
      await applyStatus(db, page);
      statusApplied = true;
    }
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
    // Fetch page N+1 while page N is written to IndexedDB.
    if (next.index < state.tables.length) {
      pending = fetchPage(next);
      void pending.catch(() => undefined);
    }
    try {
      await mergeSnapshotPage(db, tbl, page.rows, next);
    } catch (error) {
      if (pending !== null) void pending.catch(() => undefined);
      throw error;
    }
    state = next;
    onProgress?.(state.done, total);
  }
  // A pending restore replays the recovered outbox and rebuilds the caches itself;
  // doing it here as well scanned every movement and ledger row twice.
  const recovering = await getKv<boolean>(db, RECOVERY_KEY, false);
  if (!recovering) await rebuildCaches(db);
  await db.transaction('rw', db.kv, async () => {
    await setKv(db, 'pull_cursor', state.seq);
    await setKv(db, 'last_pull_at', Date.now());
    await db.kv.delete('snapshot_state');
  });
  await fixInvoiceSeq(db);
  await settleRecovery(db);
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

const RECOVERY_KEY = 'recovery_pending';
const SYSTEM_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'updated_by',
  'rev',
]);

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Restore recovery queued rows before clearing the local tables. Once the restored
 * snapshot is down, narrow each recovered master upsert to the fields that actually
 * differ from the restored server row, so this till cannot overwrite a field another
 * till changed after the restore point.
 */
export async function reconcileRecoveredMasterFields(
  db: BikriDb,
): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const entries = await db.outbox.toArray();
    for (const entry of entries) {
      if (
        entry.recovery !== true ||
        entry.kind === 'insert' ||
        isLedgerTable(entry.tbl)
      )
        continue;
      const local = (await db.table(entry.tbl).get(entry.row_id)) as
        | Record<string, unknown>
        | undefined;
      // The pre-restore shadow is cleared with the local tables. Keep it for any recovered
      // edit/delete so a rejection can be discarded back to the restored row.
      if (local && !(await db.pull_shadow.get([entry.tbl, entry.row_id])))
        await db.pull_shadow.put({
          tbl: entry.tbl,
          id: entry.row_id,
          row: local,
        });
      if (entry.kind !== 'upsert' || !entry.row) continue;
      // A row created after the restore point has no server copy: keep the full upsert.
      if (!local) continue;
      const localUpdatedAt = Number(local.updated_at ?? 0);
      const entryUpdatedAt = Number(
        entry.row.updated_at ?? entry.created_at ?? 0,
      );
      // If the restored row is newer than this till's local copy, another till has
      // changed it since the restore point. Do not send the old local values back.
      const changed =
        localUpdatedAt > entryUpdatedAt
          ? []
          : Object.keys(entry.row).filter(
              (key) =>
                !SYSTEM_FIELDS.has(key) &&
                !sameValue(entry.row?.[key], local[key]),
            );
      if (changed.length === 0) {
        // The restored row already matches this till's copy; keeping a no-op op with
        // its stale base_rev caused a spurious merge or a permanent rejection (POS-H5).
        if (entry.seq !== undefined) await db.outbox.delete(entry.seq);
        await db.pull_shadow.delete([entry.tbl, entry.row_id]);
        continue;
      }
      const narrowed: Record<string, unknown> = { id: entry.row.id };
      for (const key of changed) narrowed[key] = entry.row[key];
      if ('updated_at' in entry.row) narrowed.updated_at = entry.row.updated_at;
      if ('updated_by' in entry.row) narrowed.updated_by = entry.row.updated_by;
      if (entry.seq !== undefined)
        await db.outbox.update(entry.seq, {
          changed_fields: changed,
          row: narrowed,
          base_rev: Number(local.rev ?? 0),
        });
    }
  });
}

/**
 * Make the recovered rows visible again immediately. The snapshot only contains the
 * restored point; rows queued after it live in the outbox. This is also safe for any
 * other pending local edits: their payloads are the local state that was cleared.
 */
export async function replayOutboxLocally(db: BikriDb): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    // Failed ops are not part of the restored state: their local rows were rejected
    // and should stay hidden until the user retries or discards them.
    const entries = (await db.outbox.orderBy('seq').toArray()).filter(
      (entry) => entry.status === 'pending' || entry.status === 'sending',
    );
    for (const entry of entries) {
      const table = db.table(entry.tbl);
      if (!entry.row) {
        if (entry.kind !== 'delete' || isLedgerTable(entry.tbl)) continue;
        const current = (await table.get(entry.row_id)) as
          | Record<string, unknown>
          | undefined;
        if (current && !current.deleted_at) {
          await table.update(entry.row_id, {
            deleted_at: entry.created_at,
            updated_at: entry.created_at,
            updated_by: entry.updated_by ?? null,
          });
        }
        continue;
      }
      if (isLedgerTable(entry.tbl)) {
        if (entry.tbl === 'refund_lines') {
          // The outbox row was stripped of the till-only business_date; restore it
          // from the refund so the recovered line stays in the reports' date indexes.
          const line = entry.row as Record<string, unknown>;
          const refund = await db.refunds.get(String(line.refund_id));
          await table.put(
            (refund?.business_date === undefined
              ? line
              : { ...line, business_date: refund.business_date }) as never,
          );
          continue;
        }
        await table.put(entry.row);
        continue;
      }
      const current = (await table.get(entry.row_id)) as
        | Record<string, unknown>
        | undefined;
      await table.put({
        ...(current ?? {}),
        ...entry.row,
        rev: current?.rev ?? 0,
      });
    }
  });
  await rebuildCaches(db);
}

export async function settleRecovery(db: BikriDb): Promise<void> {
  if (!(await getKv<boolean>(db, RECOVERY_KEY, false))) return;
  await reconcileRecoveredMasterFields(db);
  await replayOutboxLocally(db);
  // Recovered sales are replayed after the snapshot's counter fix; include them before
  // the till allocates another invoice number.
  await fixInvoiceSeq(db);
  await db.kv.delete(RECOVERY_KEY);
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Rebuild coherent documents so a recovered transaction stays under the server's op cap. */
function recoveryGroups(rows: RecoveredOp[]): RecoveredOp[][] {
  // A void & reissue is one document for the Worker: `checks/refunds.ts` requires the
  // `sale_voids` row with a replacement and the replacement `sales` row in the same
  // push group. Group the void, its reversal rows and the replacement bill (with its
  // own lines/payments/ledger/movements) under the replacement sale, so a 200-op chunk
  // boundary can never split a reissue into two rejected transactions.
  const voidGroupById = new Map<string, string>();
  const voidGroupBySale = new Map<string, string>();
  for (const { tbl, row } of rows) {
    if (tbl !== 'sale_voids') continue;
    const id = String(row.id);
    const saleId = text(row.sale_id);
    const replacement = text(row.replacement_sale_id);
    const group = replacement !== '' ? `sale:${replacement}` : `void:${id}`;
    voidGroupById.set(id, group);
    if (saleId !== '') voidGroupBySale.set(saleId, group);
  }
  const voidGroup = (id: string): string =>
    voidGroupById.get(id) ?? `void:${id}`;

  const paymentGroup = new Map<string, string>();
  for (const { tbl, row } of rows) {
    if (tbl !== 'payments') continue;
    const sale = text(row.sale_id);
    const refund = text(row.refund_id);
    const purchase = text(row.purchase_id);
    const sret = text(row.supplier_return_id);
    let key = `pay:${String(row.id)}`;
    // A refund payment carries BOTH sale_id and refund_id; the refund document owns it.
    // Grouping it under the sale would split it from the refund it pays for and make both
    // transactions fail server-side after a restore (the sale group cannot see the refund
    // header, and the refund group has no payment).
    if (sale && row.purpose === 'void')
      key = voidGroupBySale.get(sale) ?? `void:${sale}`;
    else if (refund) key = `refund:${refund}`;
    else if (sret) key = `sret:${sret}`;
    else if (purchase) key = `purchase:${purchase}`;
    else if (sale) key = `sale:${sale}`;
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
        return voidGroup(String(row.id));
      case 'payments':
        return paymentGroup.get(String(row.id)) ?? `pay:${String(row.id)}`;
      case 'expenses':
        return `expense:${String(row.id)}`;
      case 'audit_log': {
        const entity = text(row.entity);
        const id = text(row.entity_id);
        if (entity === 'sale_voids') return voidGroup(id);
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
        if (source === 'void') return voidGroup(id);
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
        if (reason === 'void_return') return voidGroup(id);
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
      created_at: Number(item.row.updated_at ?? item.row.created_at ?? now),
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
    created_at: Number(item.row.updated_at ?? item.row.created_at ?? now),
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
    created_at: Number(row.created_at ?? now),
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
  return withSyncLock(db, () =>
    restoreRecoveryUnlocked(db, restorePointAt, restoreEpoch, onProgress),
  );
}

async function restoreRecoveryUnlocked(
  db: BikriDb,
  restorePointAt: number,
  restoreEpoch: string,
  onProgress?: Progress,
): Promise<void> {
  const device = await deviceInfo(db);
  const startingEpoch = await getKv<string | null>(db, 'restore_epoch', null);
  const now = Date.now();
  if (device) {
    const start = await tillRequest<
      {
        snapshot_seq: number;
        tables: { tbl: string; rows: number }[];
      } & StatusPayload
    >(db, '/sync/snapshot');
    await applyStatus(db, start);
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
      // Another tab may have completed a recovery while this one waited for the pull
      // lock (or on a browser without Web Locks). Do not clear its fresh snapshot.
      const storedEpoch = (await db.kv.get('restore_epoch'))?.value ?? null;
      if (storedEpoch !== startingEpoch) return;
      const recoveredRows: RecoveredOp[] = [];
      const outbox = await db.outbox.toArray();
      // A row that is still queued will be pushed by its original op. Re-enqueueing it
      // here would put the same ledger id in one push twice, and the Worker rejects
      // both transactions.
      const queued = new Set(
        outbox
          .filter(
            (entry) => entry.status === 'pending' || entry.status === 'sending',
          )
          .map((entry) => `${entry.tbl}:${entry.row_id}`),
      );
      // A failed transaction was rejected and must not be re-sent automatically, but its
      // local rows must survive the clear below: the user still has to Retry or Discard it
      // (Settings → Sync). Keep the whole transaction (a document plus its lines) and any
      // pre-edit restore point, and leave it out of recovery.
      const failedTx = new Set(
        outbox
          .filter((entry) => entry.status === 'failed')
          .map((entry) => entry.tx_id),
      );
      const failedKeys = new Set(
        outbox
          .filter((entry) => failedTx.has(entry.tx_id))
          .map((entry) => `${entry.tbl}:${entry.row_id}`),
      );
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
        // Parent documents only: bounded by the restore point via the local
        // `created_at` index instead of loading every sale/refund/purchase ever.
        for (const tbl of PULLED_TABLES) {
          if (!isLedgerTable(tbl) || lineParents[tbl]) continue;
          const rows = (await db
            .table(tbl)
            .where('created_at')
            .aboveOrEqual(restorePointAt)
            .toArray()) as SyncedRow[];
          for (const row of rows) {
            if (
              row.device_id !== device.id ||
              queued.has(`${tbl}:${row.id}`) ||
              failedKeys.has(`${tbl}:${row.id}`)
            )
              continue;
            const set = recovered.get(tbl) ?? new Set<string>();
            set.add(String(row.id));
            recovered.set(tbl, set);
            recoveredRows.push({ tbl: tbl as LedgerTable, row });
          }
        }
        // Child lines only for the parents recovered above (100 ids per index range).
        for (const [tbl, parent] of Object.entries(lineParents)) {
          if (!isLedgerTable(tbl)) continue;
          const ids = [...(recovered.get(parent.table) ?? [])];
          for (let at = 0; at < ids.length; at += 100) {
            const chunk = ids.slice(at, at + 100);
            const rows = (await db
              .table(tbl)
              .where(parent.field)
              .anyOf(chunk)
              .toArray()) as SyncedRow[];
            for (const row of rows) {
              if (
                queued.has(`${tbl}:${row.id}`) ||
                failedKeys.has(`${tbl}:${row.id}`)
              )
                continue;
              recoveredRows.push({ tbl: tbl as LedgerTable, row });
            }
          }
        }
      }
      // Master rows created or updated after the restore point are not in the restored
      // server copy. Re-send them first so recovered sales/payments/expenses have their
      // customer, product, category and staff references.
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
          if (failedKeys.has(`${tbl}:${row.id}`)) continue;
          if (tbl !== 'staff' && queued.has(`${tbl}:${row.id}`)) continue;
          masterRows.push({
            tbl: tbl as MasterTable,
            row,
            deleted: row.deleted_at != null,
          });
        }
      }

      // A tracked product's last_cost will be recomputed by the recovered costed
      // movement; sending the old value in a separate transaction would need the
      // delivery in the same group and could be rejected (POS-H5).
      const costedProducts = new Set<string>();
      for (const { tbl, row } of recoveredRows) {
        if (tbl === 'stock_movements' && row.unit_cost != null)
          costedProducts.add(String(row.product_id ?? ''));
      }
      for (let index = 0; index < masterRows.length; index += 1) {
        const item = masterRows[index];
        if (
          item?.tbl !== 'products' ||
          Number(item.row.track_stock ?? 0) !== 1 ||
          !costedProducts.has(String(item.row.id))
        )
          continue;
        const row = { ...item.row };
        delete row.last_cost;
        masterRows[index] = { ...item, row };
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

      const recipeByBundle = new Map<string, RecoveredMaster[]>();
      for (const item of masterRows) {
        if (item.tbl !== 'bundle_items') continue;
        const bundleId = String(item.row.bundle_id ?? '');
        recipeByBundle.set(bundleId, [
          ...(recipeByBundle.get(bundleId) ?? []),
          item,
        ]);
      }
      const usedRecipe = new Set<string>();
      for (const item of masterRows) {
        if (item.tbl === 'staff' || item.tbl === 'bundle_items') continue;
        if (openingKeys.has(`${item.tbl}:${item.row.id}`)) continue;
        const drafts = [masterDraft(item, now)];
        const rows: SyncedRow[] = [item.row];
        if (item.tbl === 'products' && String(item.row.kind) === 'bundle') {
          for (const recipe of recipeByBundle.get(String(item.row.id)) ?? []) {
            drafts.push(masterDraft(recipe, now));
            rows.push(recipe.row);
            usedRecipe.add(String(recipe.row.id));
          }
        }
        addUnit(drafts, rows);
      }
      // A recipe row whose bundle product is not being re-sent (it already exists on
      // the restored server) still needs its own unit.
      for (const item of masterRows) {
        if (item.tbl !== 'bundle_items') continue;
        if (usedRecipe.has(String(item.row.id))) continue;
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

      await db.kv.put({ key: RECOVERY_KEY, value: true });
      for (const unit of units) {
        // One transaction per document/unit: a rejected unit cannot quarantine the
        // other recovered rows, and a bundle product stays with its recipe (POS-H5).
        const txId = newId(now);
        const drafts: OutboxDraft[] = [];
        for (const id of unit.staff) {
          const staff = newStaff.get(id);
          if (staff) drafts.push(masterDraft(staff, now));
        }
        drafts.push(...unit.drafts);
        if (drafts.length > MAX_OPS_PER_TX)
          throw new Error('restore recovery unit exceeds the op limit');
        for (const draft of drafts) {
          await db.outbox.add({
            op_id: newId(now),
            tx_id: txId,
            ...draft,
            status: 'pending',
            attempts: 0,
            recovery: true,
          });
        }
      }
      // Capture the failed transactions' local rows and restore points before the clear.
      const pulled = new Set<string>(PULLED_TABLES);
      const preserved: { tbl: string; row: SyncedRow }[] = [];
      for (const key of failedKeys) {
        const at = key.indexOf(':');
        const tbl = key.slice(0, at);
        const id = key.slice(at + 1);
        if (at < 0 || id === '' || !pulled.has(tbl)) continue;
        const row = (await db.table(tbl).get(id)) as SyncedRow | undefined;
        if (row) preserved.push({ tbl, row });
      }
      const preservedShadows = (await db.pull_shadow.toArray()).filter(
        (shadow) => failedKeys.has(`${shadow.tbl}:${shadow.id}`),
      );
      for (const tbl of PULLED_TABLES) await db.table(tbl).clear();
      await db.stock_levels.clear();
      await db.party_balances.clear();
      await db.pull_shadow.clear();
      // A failed action stays visible and discardable after the restore, instead of being
      // silently deleted from the till while its outbox entry survives.
      for (const { tbl, row } of preserved) await db.table(tbl).put(row);
      for (const shadow of preservedShadows) await db.pull_shadow.put(shadow);
      await db.kv.put({ key: 'pull_cursor', value: 0 });
      await db.kv.put({ key: 'restore_epoch', value: restoreEpoch });
    });
  } catch (error) {
    // Keep the snapshot checkpoint while recovery is pending so the next pull resumes it.
    if (!(await getKv<boolean>(db, RECOVERY_KEY, false)))
      await db.kv.delete('snapshot_state');
    throw error;
  }
  // Resumes the snapshot state saved before the clear, even if the previous attempt failed.
  await runSnapshotUnlocked(db, onProgress);
}

/** Pull, snapshot and restore recovery (03 §4.2–4.3). */
import { type LedgerTable, newId, opRow } from '@bikri/core';
import type { BikriDb, SyncedRow } from '@bikri/db';
import { rebuildCaches } from '../data/caches.ts';
import { getKv, setKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { SyncHttpError, tillRequest } from './client.ts';
import { mergeRows, mergeScope } from './merge.ts';
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
      await restoreRecovery(db, res.restore_point_at, onSnapshot);
      await setKv(db, 'restore_epoch', res.restore_epoch);
      continue;
    }
    const tbls = new Set(res.changes.map((c) => c.tbl));
    await db.transaction('rw', mergeScope(tbls), async (tx) => {
      await mergeRows(
        tx,
        res.changes.map((c) => ({ tbl: c.tbl, row: c.row })),
        { caches: true },
      );
      await tx.table('kv').put({ key: 'pull_cursor', value: res.next_since });
      await tx.table('kv').put({ key: 'last_pull_at', value: Date.now() });
    });
    if (!res.has_more) break;
  }
  return serverTime;
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
export async function restoreRecovery(
  db: BikriDb,
  restorePointAt: number,
  onProgress?: Progress,
): Promise<void> {
  const device = await deviceInfo(db);
  const now = Date.now();
  await db.transaction('rw', db.tables, async () => {
    if (device) {
      const txId = newId(now);
      for (const tbl of PULLED_TABLES) {
        if (!isLedgerTable(tbl)) continue;
        const rows = (await db.table(tbl).toArray()) as SyncedRow[];
        for (const row of rows) {
          const mine =
            row.device_id === undefined ? false : row.device_id === device.id;
          if (!mine || Number(row.created_at ?? 0) < restorePointAt) continue;
          await db.outbox.add({
            op_id: newId(now),
            tx_id: txId,
            tbl: tbl as LedgerTable,
            kind: 'insert',
            row_id: row.id,
            row: opRow(tbl as LedgerTable, row),
            created_at: now,
            status: 'pending',
            attempts: 0,
          });
        }
      }
    }
    for (const tbl of PULLED_TABLES) await db.table(tbl).clear();
    await db.stock_levels.clear();
    await db.party_balances.clear();
    await db.pull_shadow.clear();
    await db.kv.put({ key: 'pull_cursor', value: 0 });
    await db.kv.delete('snapshot_state');
  });
  await runSnapshot(db, onProgress);
}

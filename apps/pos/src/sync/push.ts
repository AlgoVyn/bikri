/** Outbox push (03 §3, §4.1): seq order, ≤ 200 ops and ≤ 512 KB per batch, cut between transactions. */
import {
  APP_VERSION,
  CLIENT_SCHEMA_VERSION,
  isLedgerTable,
  newId,
} from '@bikri/core';
import type { BikriDb, OutboxEntry, SyncedRow } from '@bikri/db';
import type { Table, Transaction } from 'dexie';
import { rebuildCaches } from '../data/caches.ts';
import { setKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { jsonBytes, nextTxBatch } from './chunk.ts';
import { tillRequest } from './client.ts';
import { applyStatus, type StatusPayload } from './status.ts';

export { MAX_BATCH_BYTES, MAX_BATCH_OPS } from './chunk.ts';

export type WireOp = {
  op_id: string;
  tx_id: string;
  tbl: string;
  kind: 'insert' | 'upsert' | 'delete';
  row?: Record<string, unknown>;
  row_id?: string;
  base_rev?: number;
  changed_fields?: string[];
  updated_by?: string | null;
  created_at?: number;
};

export function toWire(e: OutboxEntry): WireOp {
  if (e.kind === 'delete') {
    return {
      op_id: e.op_id,
      tx_id: e.tx_id,
      tbl: e.tbl,
      kind: 'delete',
      row_id: e.row_id,
      base_rev: e.base_rev ?? 0,
      updated_by: e.updated_by ?? null,
      created_at: e.created_at,
    };
  }
  if (e.kind === 'upsert') {
    return {
      op_id: e.op_id,
      tx_id: e.tx_id,
      tbl: e.tbl,
      kind: 'upsert',
      row: e.row ?? {},
      base_rev: e.base_rev ?? 0,
      changed_fields: e.changed_fields ?? [],
      created_at: e.created_at,
    };
  }
  return {
    op_id: e.op_id,
    tx_id: e.tx_id,
    tbl: e.tbl,
    kind: 'insert',
    row: e.row ?? {},
    created_at: e.created_at,
  };
}

/** The next batch: whole transactions only (a single oversized transaction is still sent alone). */
export function nextBatch(pending: OutboxEntry[]): OutboxEntry[] {
  return nextTxBatch(pending, (entry) => jsonBytes(toWire(entry)));
}

type PushResponse = {
  results: {
    op_id: string;
    result: 'applied' | 'conflict_merged' | 'rejected';
    error_code?: string;
    server_rev?: number;
  }[];
  server_time: number;
  latest_seq: number;
} & StatusPayload;

export type PushOutcome = {
  sent: number;
  applied: number;
  rejected: number;
  serverTime: number | null;
};

/** A claim older than this was left by a crashed/closed tab, not a live request. */
const CLAIM_STALE_MS = 2 * 60_000;

/**
 * Pushes every pending op. Throws SyncHttpError / OfflineError for the engine to handle.
 * A cross-tab lock stops two tills from claiming and sending dependent transactions
 * out of order; the server is still idempotent when a lock is unavailable.
 */
export async function pushAll(
  db: BikriDb,
  maxRounds = 20,
): Promise<PushOutcome> {
  const locks = globalThis.navigator?.locks;
  if (locks?.request)
    return locks.request('bikri-push', () =>
      pushAllUnlocked(db, maxRounds),
    ) as Promise<PushOutcome>;
  return pushAllUnlocked(db, maxRounds);
}

async function pushAllUnlocked(
  db: BikriDb,
  maxRounds = 20,
): Promise<PushOutcome> {
  const device = await deviceInfo(db);
  const out: PushOutcome = {
    sent: 0,
    applied: 0,
    rejected: 0,
    serverTime: null,
  };
  if (!device) return out;
  // A reload, a closed tab or a stopped engine can leave rows in `sending` forever. That is
  // not just a delay: pending ops behind them would be sent without their prerequisites
  // (a product before its owner staff row is a real example), so the server would reject
  // them. Reclaim every unfinished claim now. A second push of the same op is safe: the
  // server answers from `applied_ops`, and this tab then settles the row itself.
  // Only reclaim a claim that is older than a live request. A second tab's in-flight
  // claim must never be stolen: the two requests could arrive out of order and a
  // dependent transaction (staff create then sale) would be rejected.
  const staleBefore = Date.now() - CLAIM_STALE_MS;
  await db.outbox
    .where('status')
    .equals('sending')
    .filter((entry) => (entry.sending_at ?? 0) < staleBefore)
    .modify({
      status: 'pending',
      sending_at: undefined,
      claim_token: undefined,
    });
  for (let round = 0; round < maxRounds; round += 1) {
    let batch: OutboxEntry[] = [];
    let seqs: number[] = [];
    let claimToken = '';
    // Read, choose the batch and claim it in one transaction. A later edit must see
    // `sending` and create a fresh op instead of coalescing into the payload we send.
    await db.transaction('rw', db.outbox, async () => {
      const pending = await db.outbox
        .where('status')
        .equals('pending')
        .sortBy('seq');
      if (pending.length === 0) return;
      batch = nextBatch(pending);
      seqs = batch
        .map((entry) => entry.seq)
        .filter((seq): seq is number => seq !== undefined);
      claimToken = newId();
      await db.outbox.where('seq').anyOf(seqs).modify({
        status: 'sending',
        sending_at: Date.now(),
        sent_at: Date.now(),
        claim_token: claimToken,
      });
    });
    if (batch.length === 0) break;
    let res: PushResponse;
    try {
      res = await tillRequest<PushResponse>(db, '/sync/push', {
        method: 'POST',
        json: {
          device_id: device.id,
          schema_version: CLIENT_SCHEMA_VERSION,
          app_version: APP_VERSION,
          ops: batch.map(toWire),
        },
      });
    } catch (error) {
      // A transport error leaves the ops pending for the next tick; a mutation made while this
      // request was in flight must not coalesce into them.
      await db.outbox.where('seq').anyOf(seqs).modify({
        status: 'pending',
        sending_at: undefined,
        claim_token: undefined,
      });
      throw error;
    }
    out.sent += batch.length;
    out.serverTime = res.server_time;
    const bySeq = new Map(batch.map((e) => [e.op_id, e]));
    // Every table in the batch, including ledger tables: the settle reads an applied
    // op's local row when a newer op is still pending. Dexie throws if a table is used
    // outside the transaction scope.
    const batchTables = [...new Set(batch.map((entry) => db.table(entry.tbl)))];
    await db.transaction(
      'rw',
      [db.outbox, db.pull_shadow, db.kv, ...batchTables],
      async () => {
        const answered = new Set(res.results.map((r) => r.op_id));
        for (const r of res.results) {
          const entry = bySeq.get(r.op_id);
          if (entry?.seq === undefined) continue;
          const current = await db.outbox.get(entry.seq);
          // Another tab may have reclaimed this row (or it changed) while the request
          // was in flight; only the claim owner may settle it.
          if (
            current === undefined ||
            current.op_id !== r.op_id ||
            current.claim_token !== claimToken
          )
            continue;
          if (r.result === 'rejected') {
            out.rejected += 1;
            await db.outbox.update(entry.seq, {
              status: 'failed',
              last_error: r.error_code ?? 'REJECTED',
              sending_at: undefined,
              claim_token: undefined,
              attempts: entry.attempts + 1,
            });
          } else {
            out.applied += 1;
            await db.outbox.delete(entry.seq);
            // A newer op for the same row may still be pending (for example one queued
            // while this request was in flight). Its restore point is the row the server
            // just accepted, not the older shadow; delete the shadow if we cannot replace it.
            const newer = await db.outbox
              .where('[tbl+row_id]')
              .equals([entry.tbl, entry.row_id])
              .filter(
                (candidate) =>
                  candidate.status === 'pending' ||
                  candidate.status === 'sending',
              )
              .count();
            if (newer > 0) {
              // Keep a restore point for the newer op. For an applied upsert, replace it
              // with the row the server now has; for a delete or a field merge, keep the
              // shadow the newer op recorded when it was queued.
              if (r.result === 'applied' && entry.row) {
                // Keep the server-managed columns (avg_cost, sales.status, …) from the
                // current local row; the op payload intentionally omits them.
                const local = (await db.table(entry.tbl).get(entry.row_id)) as
                  | Record<string, unknown>
                  | undefined;
                await db.pull_shadow.put({
                  tbl: entry.tbl,
                  id: entry.row_id,
                  row: {
                    ...(local ?? {}),
                    ...entry.row,
                    id: entry.row_id,
                    rev: r.server_rev ?? local?.rev ?? 0,
                  },
                });
              }
            } else {
              await db.pull_shadow.delete([entry.tbl, entry.row_id]);
            }
            // Keep the local optimistic revision current; otherwise the next edit of
            // this row would use a stale base_rev and be needlessly field-merged.
            // Only a plain applied result proves the local row equals the server row.
            // A field merge keeps fields from the other device; adopting its revision
            // here would let the next edit overwrite that device's field with our stale
            // copy. Keep the old base revision until the merged row is pulled.
            if (
              r.result === 'applied' &&
              !isLedgerTable(entry.tbl) &&
              typeof r.server_rev === 'number' &&
              Number.isSafeInteger(r.server_rev)
            )
              await db
                .table(entry.tbl)
                .update(entry.row_id, { rev: r.server_rev });
          }
        }
        for (const entry of batch) {
          if (entry.seq === undefined || answered.has(entry.op_id)) continue;
          await db.outbox.update(entry.seq, {
            status: 'pending',
            sending_at: undefined,
            claim_token: undefined,
          });
        }
        await setKv(db, 'last_push_at', Date.now());
      },
    );
    await applyStatus(db, res);
    // Nothing processed (call budget on the server): stop, retry on the next tick.
    if (res.results.length === 0) break;
  }
  return out;
}

/** Failed ops: Retry re-queues the whole failed action with fresh op ids; Discard (owner) drops it. */
export async function retryFailed(db: BikriDb, seqs: number[]): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const picked = await db.outbox.where('seq').anyOf(seqs).toArray();
    const txIds = new Set(
      picked
        .filter((entry) => entry.status === 'failed')
        .map((entry) => entry.tx_id),
    );
    if (txIds.size === 0) return;
    const entries = (await db.outbox.toArray()).filter(
      (entry) => entry.status === 'failed' && txIds.has(entry.tx_id),
    );
    for (const entry of entries) {
      if (entry.seq === undefined) continue;
      // The server caches rejected op ids in applied_ops; a new id makes Retry meaningful.
      await db.outbox.update(entry.seq, {
        op_id: newId(),
        status: 'pending',
        attempts: 0,
        last_error: undefined,
      });
    }
  });
}

/**
 * Recomputes the `sales.status` cache for documents whose refund/void rows were
 * discarded. The status is normally changed in the same transaction as the refund or
 * void (03 §6); discarding one reverses that change but leaves the cache behind.
 */
async function recomputeDiscardedStatuses(
  tx: Transaction,
  saleIds: ReadonlySet<string>,
): Promise<void> {
  for (const saleId of saleIds) {
    const sales = tx.table('sales') as Table<SyncedRow, string>;
    const sale = await sales.get(saleId);
    if (!sale) continue;
    const voided = await tx
      .table('sale_voids')
      .where('sale_id')
      .equals(saleId)
      .count();
    if (voided > 0) {
      if (sale.status !== 'void')
        await sales.update(saleId, { status: 'void' });
      continue;
    }
    const refunds = (await tx
      .table('refunds')
      .where('sale_id')
      .equals(saleId)
      .toArray()) as SyncedRow[];
    const saleLines = (await tx
      .table('sale_lines')
      .where('sale_id')
      .equals(saleId)
      .toArray()) as SyncedRow[];
    const refundIds = refunds.map((refund) => String(refund.id));
    const refundedByLine = new Map<string, number>();
    if (refundIds.length > 0) {
      const lines = (await tx
        .table('refund_lines')
        .where('refund_id')
        .anyOf(refundIds)
        .toArray()) as SyncedRow[];
      for (const line of lines) {
        const key = String(line.sale_line_id);
        refundedByLine.set(
          key,
          (refundedByLine.get(key) ?? 0) + Number(line.qty_milli ?? 0),
        );
      }
    }
    // A sale cannot hold a void and a refund at once, so a discarded void leaves no
    // rows here and the bill returns to paid (or to its remaining refunds). `refunded`
    // means every line's refunded quantity equals its sold quantity (02 §4).
    const fullyRefunded =
      saleLines.length > 0 &&
      saleLines.every(
        (line) =>
          (refundedByLine.get(String(line.id)) ?? 0) >=
          Number(line.qty_milli ?? 0),
      );
    const status = fullyRefunded
      ? 'refunded'
      : refunds.length > 0
        ? 'part_refunded'
        : 'paid';
    if (sale.status !== status) await sales.update(saleId, { status });
  }
}

export async function discardFailed(
  db: BikriDb,
  seqs: number[],
): Promise<void> {
  let ledgerChanged = false;
  await db.transaction('rw', db.tables, async (tx) => {
    const failed = (await db.outbox.where('seq').anyOf(seqs).toArray()).filter(
      (e) => e.seq !== undefined && e.status === 'failed',
    );
    if (failed.length === 0) return;
    // A rejected document is one transaction. Remove every still-queued row of that transaction
    // (queued child lines included), not just the row the UI happened to show.
    const txIds = [...new Set(failed.map((e) => e.tx_id))];
    const entries = (await db.outbox.toArray()).filter((e) =>
      txIds.includes(e.tx_id),
    );
    // A newer action may still be waiting for the same row. Restoring an older shadow
    // would then overwrite that newer local edit, so leave the row for its own op.
    const otherKeys = new Set(
      (await db.outbox.toArray())
        .filter((e) => !txIds.includes(e.tx_id))
        .map((e) => `${e.tbl}:${e.row_id}`),
    );
    const saleIds = new Set<string>();
    for (const e of entries) {
      if (e.seq === undefined) continue;
      const rowKey = `${e.tbl}:${e.row_id}`;
      if (isLedgerTable(e.tbl)) {
        if (e.tbl === 'refunds' || e.tbl === 'sale_voids') {
          const row = await db.table(e.tbl).get(e.row_id);
          if (row && typeof row.sale_id === 'string') saleIds.add(row.sale_id);
        }
        if (!otherKeys.has(rowKey)) {
          await db.table(e.tbl).delete(e.row_id);
          await db.pull_shadow.delete([e.tbl, e.row_id]);
          ledgerChanged = true;
        }
      } else if (!otherKeys.has(rowKey)) {
        const shadow = await db.pull_shadow.get([e.tbl, e.row_id]);
        if (shadow) {
          await db.table(e.tbl).put(shadow.row);
          await db.pull_shadow.delete([e.tbl, e.row_id]);
        } else if (e.kind === 'upsert' && (e.base_rev ?? 0) === 0) {
          // A rejected local create has no server copy to restore.
          await db.table(e.tbl).delete(e.row_id);
        }
      }
      await db.outbox.delete(e.seq);
    }
    await recomputeDiscardedStatuses(tx, saleIds);
  });
  if (ledgerChanged) await rebuildCaches(db);
}

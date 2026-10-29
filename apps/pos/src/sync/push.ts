/** Outbox push (03 §3, §4.1): seq order, ≤ 200 ops and ≤ 512 KB per batch, cut between transactions. */
import { APP_VERSION, CLIENT_SCHEMA_VERSION, isLedgerTable } from '@bikri/core';
import type { BikriDb, OutboxEntry } from '@bikri/db';
import { rebuildCaches } from '../data/caches.ts';
import { setKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { tillRequest } from './client.ts';
import { applyStatus, type StatusPayload } from './status.ts';

export const MAX_BATCH_OPS = 200;
export const MAX_BATCH_BYTES = 512 * 1024;

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
  const batch: OutboxEntry[] = [];
  let bytes = 0;
  let i = 0;
  while (i < pending.length) {
    const tx = pending[i]?.tx_id;
    let j = i;
    let txBytes = 0;
    while (j < pending.length && pending[j]?.tx_id === tx) {
      txBytes += JSON.stringify(toWire(pending[j] as OutboxEntry)).length;
      j += 1;
    }
    const count = j - i;
    if (
      batch.length > 0 &&
      (batch.length + count > MAX_BATCH_OPS ||
        bytes + txBytes > MAX_BATCH_BYTES)
    )
      break;
    batch.push(...pending.slice(i, j));
    bytes += txBytes;
    i = j;
    if (batch.length >= MAX_BATCH_OPS) break;
  }
  return batch;
}

type PushResponse = {
  results: {
    op_id: string;
    result: 'applied' | 'conflict_merged' | 'rejected';
    error_code?: string;
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

/** Pushes every pending op. Throws SyncHttpError / OfflineError for the engine to handle. */
export async function pushAll(
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
  // A tab closed mid-request leaves rows in `sending`; the server is idempotent, so retry them.
  await db.outbox
    .where('status')
    .equals('sending')
    .modify({ status: 'pending' });
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = await db.outbox
      .where('status')
      .equals('pending')
      .sortBy('seq');
    if (pending.length === 0) break;
    const batch = nextBatch(pending);
    const seqs = batch
      .map((entry) => entry.seq)
      .filter((seq): seq is number => seq !== undefined);
    await db.outbox.where('seq').anyOf(seqs).modify({ status: 'sending' });
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
      await db.outbox.where('seq').anyOf(seqs).modify({ status: 'pending' });
      throw error;
    }
    out.sent += batch.length;
    out.serverTime = res.server_time;
    const bySeq = new Map(batch.map((e) => [e.op_id, e]));
    await db.transaction('rw', [db.outbox, db.pull_shadow, db.kv], async () => {
      const answered = new Set(res.results.map((r) => r.op_id));
      for (const r of res.results) {
        const entry = bySeq.get(r.op_id);
        if (entry?.seq === undefined) continue;
        if (r.result === 'rejected') {
          out.rejected += 1;
          await db.outbox.update(entry.seq, {
            status: 'failed',
            last_error: r.error_code ?? 'REJECTED',
            attempts: entry.attempts + 1,
          });
        } else {
          out.applied += 1;
          await db.outbox.delete(entry.seq);
          await db.pull_shadow.delete([entry.tbl, entry.row_id]);
        }
      }
      for (const entry of batch) {
        if (entry.seq === undefined || answered.has(entry.op_id)) continue;
        await db.outbox.update(entry.seq, { status: 'pending' });
      }
      await setKv(db, 'last_push_at', Date.now());
    });
    await applyStatus(db, res);
    // Nothing processed (call budget on the server): stop, retry on the next tick.
    if (res.results.length === 0) break;
  }
  return out;
}

/** Failed ops: Retry puts them back in the queue; Discard (owner) drops them and restores the shadow row. */
export async function retryFailed(db: BikriDb, seqs: number[]): Promise<void> {
  await db.outbox.where('seq').anyOf(seqs).modify({ status: 'pending' });
}

export async function discardFailed(
  db: BikriDb,
  seqs: number[],
): Promise<void> {
  let ledgerChanged = false;
  await db.transaction('rw', db.tables, async () => {
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
    for (const e of entries) {
      if (e.seq === undefined) continue;
      if (isLedgerTable(e.tbl)) {
        await db.table(e.tbl).delete(e.row_id);
        await db.pull_shadow.delete([e.tbl, e.row_id]);
        ledgerChanged = true;
      } else {
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
  });
  if (ledgerChanged) await rebuildCaches(db);
}

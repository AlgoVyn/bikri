/** Outbox push (03 §3, §4.1): seq order, ≤ 200 ops and ≤ 512 KB per batch, cut between transactions. */
import { APP_VERSION, CLIENT_SCHEMA_VERSION } from '@bikri/core';
import type { BikriDb, OutboxEntry } from '@bikri/db';
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
    };
  }
  return {
    op_id: e.op_id,
    tx_id: e.tx_id,
    tbl: e.tbl,
    kind: 'insert',
    row: e.row ?? {},
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
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = await db.outbox
      .where('status')
      .equals('pending')
      .sortBy('seq');
    if (pending.length === 0) break;
    const batch = nextBatch(pending);
    const res = await tillRequest<PushResponse>(db, '/sync/push', {
      method: 'POST',
      json: {
        device_id: device.id,
        schema_version: CLIENT_SCHEMA_VERSION,
        app_version: APP_VERSION,
        ops: batch.map(toWire),
      },
    });
    out.sent += batch.length;
    out.serverTime = res.server_time;
    const bySeq = new Map(batch.map((e) => [e.op_id, e]));
    await db.transaction('rw', [db.outbox, db.pull_shadow, db.kv], async () => {
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
  await db.transaction('rw', db.tables, async () => {
    const entries = await db.outbox.where('seq').anyOf(seqs).toArray();
    for (const e of entries) {
      if (e.seq === undefined || e.status !== 'failed') continue;
      await db.outbox.delete(e.seq);
      const shadow = await db.pull_shadow.get([e.tbl, e.row_id]);
      if (shadow) {
        await db.table(e.tbl).put(shadow.row);
        await db.pull_shadow.delete([e.tbl, e.row_id]);
      }
    }
  });
}

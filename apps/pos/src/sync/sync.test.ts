import { newId } from '@bikri/core';
import type { OutboxEntry } from '@bikri/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKv, setKv } from '../data/kv.ts';
import { dropTestDbs } from '../data/testDb.ts';
import { NOW, readyDb } from '../data/testShop.ts';
import { writeAction } from '../data/write.ts';
import {
  OfflineError,
  pendingHeader,
  SyncHttpError,
  tillRequest,
} from './client.ts';
import {
  backoffDelay,
  notifyLocalWrite,
  SyncEngine,
  syncNow,
} from './engine.ts';
import { FakeServer } from './fakeServer.ts';
import { refreshMe } from './me.ts';
import {
  fixInvoiceSeq,
  pullAll,
  reconcileRecoveredMasterFields,
  replayOutboxLocally,
  restoreRecovery,
  runSnapshot,
} from './pull.ts';
import {
  discardFailed,
  MAX_BATCH_OPS,
  nextBatch,
  pushAll,
  retryFailed,
  toWire,
} from './push.ts';
import { useSyncState } from './state.ts';
import { applyStatus, isReadOnly } from './status.ts';

let server: FakeServer;

async function enrolled(prefix: string) {
  const db = await readyDb(prefix);
  await setKv(db, 'device_token', 'tok');
  return db;
}

const product = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name_en: `P ${id}`,
  price: 100,
  rev: 1,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  ...extra,
});

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
  useSyncState
    .getState()
    .set({ phase: 'idle', error: null, progress: null, quotaUntil: null });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await dropTestDbs();
});

describe('client', () => {
  it('sends the bearer token and X-Bikri-Pending; maps errors', async () => {
    const db = await enrolled('cl');
    await writeAction(db, (w) => w.create('categories', { name_en: 'X' }), {
      now: 42,
    });
    expect(await pendingHeader(db)).toBe('1;42');
    await tillRequest(db, '/me');
    const req = server.log.at(-1);
    expect(req?.headers.get('authorization')).toBe('Bearer tok');
    expect(req?.headers.get('x-bikri-pending')).toBe('1;42');
    server.override = () => ({
      status: 503,
      json: { error: { code: 'TENANT_QUOTA', message: 'q' } },
      headers: { 'retry-after': '120' },
    });
    const err = await tillRequest(db, '/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect((err as SyncHttpError).retryAfter).toBe(120);
    server.override = () => ({ status: 500, json: null });
    expect(
      ((await tillRequest(db, '/me').catch((e: unknown) => e)) as SyncHttpError)
        .code,
    ).toBe('INTERNAL');
    server.online = false;
    expect(
      await tillRequest(db, '/me').catch((e: unknown) => e),
    ).toBeInstanceOf(OfflineError);
    await setKv(db, 'device_token', null);
    expect(
      ((await tillRequest(db, '/me').catch((e: unknown) => e)) as SyncHttpError)
        .code,
    ).toBe('UNAUTHENTICATED');
  });
});

describe('push (03 §3, §4.1)', () => {
  const entry = (
    seq: number,
    tx: string,
    extra: Partial<OutboxEntry> = {},
  ): OutboxEntry => ({
    seq,
    op_id: `op${seq}`,
    tx_id: tx,
    tbl: 'products',
    kind: 'upsert',
    row_id: `r${seq}`,
    row: { id: `r${seq}` },
    created_at: 1,
    status: 'pending',
    attempts: 0,
    ...extra,
  });

  it('cuts batches only between transactions, ≤ 200 ops and ≤ 512 KB', () => {
    const many = Array.from({ length: 150 }, (_, i) => entry(i, 'a')).concat(
      Array.from({ length: 100 }, (_, i) => entry(200 + i, 'b')),
    );
    expect(nextBatch(many)).toHaveLength(150);
    const big = 'x'.repeat(300 * 1024);
    const heavy = [
      entry(1, 'a', { row: { id: 'r1', note: big } }),
      entry(2, 'b', { row: { id: 'r2', note: big } }),
    ];
    expect(nextBatch(heavy)).toHaveLength(1);
    const full = Array.from({ length: 250 }, (_, i) => entry(i, `t${i}`));
    expect(nextBatch(full)).toHaveLength(MAX_BATCH_OPS);
    expect(
      toWire(entry(1, 'a', { kind: 'delete', updated_by: 'st-1' })),
    ).toEqual({
      op_id: 'op1',
      tx_id: 'a',
      tbl: 'products',
      kind: 'delete',
      row_id: 'r1',
      base_rev: 0,
      updated_by: 'st-1',
      created_at: 1,
    });
    expect(toWire(entry(1, 'a', { kind: 'insert', tbl: 'sales' })).kind).toBe(
      'insert',
    );
  });

  it('applied ops leave the outbox; rejected ones stay failed; retry and discard', async () => {
    const db = await enrolled('push');
    await writeAction(db, async (w) => {
      await w.create('categories', { id: 'c-ok', name_en: 'Ok' });
      await w.create('categories', { id: 'c-bad', name_en: 'Bad' });
    });
    await db.pull_shadow.put({
      tbl: 'categories',
      id: 'c-ok',
      row: { id: 'c-ok' },
    });
    server.results = (op) =>
      op.row?.id === 'c-bad'
        ? { result: 'rejected', error_code: 'UNIQUE_VIOLATION' }
        : { result: 'applied' };
    const out = await pushAll(db);
    expect(out).toMatchObject({ sent: 2, applied: 1, rejected: 1 });
    const left = await db.outbox.toArray();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      status: 'failed',
      last_error: 'UNIQUE_VIOLATION',
    });
    expect(await db.pull_shadow.count()).toBe(0);
    const body = server.log.find((l) => l.path === '/sync/push')?.body as {
      device_id: string;
      schema_version: number;
    };
    expect(body).toMatchObject({ device_id: 'dev-1', schema_version: 2 });
    // A failed op is not pushed again until Retry.
    server.log = [];
    await pushAll(db);
    expect(server.log).toHaveLength(0);
    const oldOpId = left[0]?.op_id;
    await retryFailed(db, [left[0]?.seq ?? 0]);
    const retried = await db.outbox.where('status').equals('pending').first();
    expect(retried?.op_id).not.toBe(oldOpId);
    expect(await db.outbox.where('status').equals('pending').count()).toBe(1);
    await db.outbox
      .where('status')
      .equals('pending')
      .modify({ status: 'failed' });
    await db.pull_shadow.put({
      tbl: 'categories',
      id: 'c-bad',
      row: { id: 'c-bad', name_en: 'Server', rev: 1 },
    });
    await discardFailed(db, [left[0]?.seq ?? 0]);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.categories.get('c-bad'))?.name_en).toBe('Server');
  });

  it('keeps the applied row as the shadow for a newer pending edit', async () => {
    const db = await enrolled('shadow-newer');
    const category = await writeAction(
      db,
      (w) => w.create('categories', { name_en: 'First' }),
      { now: NOW },
    );
    const first = await db.outbox.orderBy('seq').first();
    if (!first?.seq) throw new Error('no op');
    // Simulate an edit queued while the first request is in flight.
    await db.outbox.update(first.seq, { status: 'sending' });
    await writeAction(
      db,
      (w) => w.update('categories', category.id, { name_en: 'Second' }),
      { now: NOW + 1 },
    );
    await db.outbox.update(first.seq, { status: 'pending' });
    expect(await db.outbox.count()).toBe(2);
    await pushAll(db);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.pull_shadow.count()).toBe(0);
  });

  it('keeps the newer restore point when a delete is applied and its follower is rejected', async () => {
    const db = await enrolled('shadow-delete');
    const category = await writeAction(
      db,
      (w) => w.create('categories', { name_en: 'First' }),
      { now: NOW },
    );
    server.results = () => ({ result: 'applied', server_rev: 1 });
    await pushAll(db);
    const stored = await db.categories.get(category.id);
    expect(stored?.rev).toBe(1);

    await writeAction(db, (w) => w.remove('categories', category.id), {
      now: NOW + 1,
    });
    const remove = await db.outbox.orderBy('seq').last();
    if (!remove?.seq) throw new Error('no op');
    await db.outbox.update(remove.seq, { status: 'sending' });
    await writeAction(
      db,
      (w) => w.update('categories', category.id, { name_en: 'Second' }),
      { now: NOW + 2 },
    );
    expect(await db.pull_shadow.count()).toBe(1);
    // The delete is applied; the follow-up edit is rejected. Its pre-delete restore
    // point must survive so discarding the failed edit does not keep the optimistic row.
    server.results = (op) =>
      op.op_id === remove.op_id
        ? { result: 'applied' }
        : { result: 'rejected', error_code: 'UNIQUE_VIOLATION' };
    await pushAll(db);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.pull_shadow.count()).toBe(1);
    expect(
      (await db.pull_shadow.get(['categories', category.id]))?.row,
    ).toMatchObject({
      id: category.id,
      deleted_at: null,
    });
  });

  it('recomputes a part-refunded status after a rejected refund is discarded', async () => {
    const db = await enrolled('discard-refund');
    await db.sales.add({
      id: 's-ref',
      total: 1000,
      status: 'refunded',
      created_at: 1,
    } as never);
    await db.refunds.bulkAdd([
      { id: 'r-keep', sale_id: 's-ref', exact_amount: 600, created_at: 1 },
      { id: 'r-bad', sale_id: 's-ref', exact_amount: 400, created_at: 1 },
    ] as never);
    await db.outbox.add({
      op_id: 'op-refund',
      tx_id: 'tx-refund',
      tbl: 'refunds',
      kind: 'insert',
      row_id: 'r-bad',
      row: { id: 'r-bad', sale_id: 's-ref' },
      created_at: 1,
      status: 'failed',
      attempts: 1,
    });
    const failed = await db.outbox.orderBy('seq').last();
    await discardFailed(db, [failed?.seq ?? 0]);
    expect((await db.sales.get('s-ref'))?.status).toBe('part_refunded');
  });

  it('adopts the server revision after an applied master write', async () => {
    const db = await enrolled('rev');
    await writeAction(db, (w) => w.create('categories', { name_en: 'New' }), {
      now: 42,
    });
    const created = (await db.categories.toArray())[0];
    if (!created) throw new Error('no category');
    expect(created.rev).toBe(0);
    await pushAll(db);
    expect((await db.categories.get(created.id))?.rev).toBe(1);

    await db.products.put(product('p1', { rev: 4, price: 100 }));
    server.results = (op) =>
      op.row?.id === 'p1'
        ? { result: 'applied', server_rev: 5 }
        : { result: 'applied', server_rev: 1 };
    await writeAction(db, (w) => w.update('products', 'p1', { price: 200 }), {
      now: 43,
    });
    await pushAll(db);
    expect(await db.products.get('p1')).toMatchObject({ price: 200, rev: 5 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('serialises a push through navigator.locks when the browser provides it', async () => {
    const db = await enrolled('push-lock');
    let used = false;
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      locks: {
        request: async (
          _name: string,
          fn: () => Promise<unknown>,
        ): Promise<unknown> => {
          used = true;
          return fn();
        },
      },
    });
    await writeAction(
      db,
      (w) => w.create('categories', { name_en: 'Locked' }),
      { now: 44 },
    );
    await pushAll(db);
    expect(used).toBe(true);
    expect(await db.outbox.count()).toBe(0);
  });

  it('queues a push requested while a pull is already running', async () => {
    const db = await enrolled('engine-queue');
    const engine = new SyncEngine(db);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    (
      engine as unknown as {
        cycle: (kind: string) => Promise<void>;
      }
    ).cycle = async (kind: string) => {
      calls.push(kind);
      if (kind === 'pull') await gate;
    };
    const pull = engine.run('pull');
    const push = engine.run('push');
    expect(calls).toEqual(['pull']);
    release();
    await Promise.all([pull, push]);
    expect(calls).toEqual(['pull', 'push']);
    engine.stop();
  });

  it('reclaims an unfinished sending claim and sends it before later ops', async () => {
    const db = await enrolled('claim');
    await writeAction(
      db,
      (w) => w.create('categories', { id: 'c-claim', name_en: 'Claim' }),
      { now: 42 },
    );
    // A reload or a stopped engine can leave a claim with no response. The next push
    // must resend it, in order, instead of skipping it and sending newer ops first.
    await db.outbox
      .toCollection()
      .modify({ status: 'sending', sending_at: Date.now() - 10 * 60_000 });
    await writeAction(
      db,
      (w) =>
        w.create('products', {
          name_en: 'Product',
          sku: 'SKU-CLAIM',
          price: 100,
        }),
      { now: 43 },
    );
    server.log = [];
    await pushAll(db);
    const pushes = server.log.filter((l) => l.path === '/sync/push');
    expect(pushes).toHaveLength(1);
    const body = pushes[0]?.body as { ops: { tbl: string }[] };
    expect(body.ops.map((op) => op.tbl)).toEqual(['categories', 'products']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('discards an empty set and a local create without a server shadow', async () => {
    const db = await enrolled('discard-edge');
    await expect(discardFailed(db, [999])).resolves.toBeUndefined();
    await writeAction(
      db,
      (w) => w.create('categories', { id: 'c-new', name_en: 'New' }),
      { now: 42 },
    );
    const entry = (await db.outbox.toArray())[0];
    await db.outbox
      .where('seq')
      .equals(entry?.seq ?? 0)
      .modify({ status: 'failed' });
    await discardFailed(db, [entry?.seq ?? 0]);
    expect(await db.categories.get('c-new')).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it('leaves an unanswered op pending instead of dropping or sending it twice', async () => {
    const db = await enrolled('unanswered');
    const first = {
      op_id: newId(),
      tx_id: newId(),
      tbl: 'products' as const,
      kind: 'upsert' as const,
      row_id: 'p-one',
      row: product('p-one'),
      base_rev: 0,
      changed_fields: [],
      created_at: Date.now(),
      status: 'pending' as const,
      attempts: 0,
    };
    const second = {
      ...first,
      op_id: newId(),
      tx_id: newId(),
      row_id: 'p-two',
      row: product('p-two'),
    };
    await db.outbox.bulkAdd([first, second]);
    let calls = 0;
    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            json: {
              results:
                calls++ === 0
                  ? [{ op_id: first.op_id, result: 'applied' }]
                  : [],
              server_time: 1,
              latest_seq: 0,
            },
          }
        : undefined;
    await pushAll(db);
    expect((await db.outbox.toArray()).map((e) => e.row_id)).toEqual(['p-two']);
    expect((await db.outbox.toArray())[0]?.status).toBe('pending');
  });

  it('returns an in-flight batch to pending when the transport fails', async () => {
    const db = await enrolled('sending');
    await db.outbox.add({
      op_id: newId(),
      tx_id: newId(),
      tbl: 'products',
      kind: 'upsert',
      row_id: 'p-send',
      row: product('p-send'),
      base_rev: 0,
      changed_fields: [],
      created_at: Date.now(),
      status: 'pending',
      attempts: 0,
    });
    server.override = ({ path }) =>
      path === '/sync/push'
        ? { status: 500, json: { error: { code: 'INTERNAL', message: 'x' } } }
        : undefined;
    await expect(pushAll(db)).rejects.toBeInstanceOf(SyncHttpError);
    expect((await db.outbox.toArray())[0]?.status).toBe('pending');
  });

  it('pushes in several batches and stops when the server processed nothing', async () => {
    const db = await enrolled('push2');
    for (let i = 0; i < 3; i += 1) {
      await writeAction(db, async (w) => {
        for (let j = 0; j < 80; j += 1)
          await w.create('categories', { name_en: `C${i}-${j}` });
      });
    }
    const out = await pushAll(db);
    expect(out.sent).toBe(240);
    expect(server.log.filter((l) => l.path === '/sync/push')).toHaveLength(2);
    await writeAction(db, (w) => w.create('categories', { name_en: 'Z' }));
    server.override = ({ path }) =>
      path === '/sync/push'
        ? { json: { results: [], server_time: 1, latest_seq: 0 } }
        : undefined;
    const none = await pushAll(db);
    expect(none.applied).toBe(0);
    expect(await db.outbox.count()).toBe(1);
  });

  it('delete ops carry updated_by (D-104)', async () => {
    const db = await enrolled('del');
    await writeAction(db, (w) =>
      w.create('categories', { id: 'c-1', name_en: 'X' }),
    );
    await db.outbox.clear();
    await writeAction(db, (w) => w.remove('categories', 'c-1'), {
      actor: 'st-1',
    });
    await pushAll(db);
    const last = server.log.at(-1)?.body as { ops: unknown[] } | undefined;
    const op = last?.ops[0];
    expect(op).toMatchObject({
      kind: 'delete',
      row_id: 'c-1',
      updated_by: 'st-1',
    });
  });
});

describe('pull (03 §4.2)', () => {
  it('applies pages, keeps pending local edits (pull_shadow), updates caches for new ledger rows', async () => {
    const db = await enrolled('pull');
    await writeAction(db, (w) =>
      w.create('categories', { id: 'c-local', name_en: 'Mine' }),
    );
    server.changes = [
      { seq: 1, tbl: 'products', op: 'upsert', row: product('p1') },
      {
        seq: 2,
        tbl: 'categories',
        op: 'upsert',
        row: { id: 'c-local', name_en: 'Server', rev: 2 },
      },
      {
        seq: 3,
        tbl: 'stock_movements',
        op: 'upsert',
        row: {
          id: 'sm1',
          product_id: 'p1',
          qty_delta_milli: 5000,
          created_at: 1,
          device_id: 'dev-2',
        },
      },
      { seq: 4, tbl: 'nonsense', op: 'upsert', row: { id: 'x' } },
    ];
    for (let i = 5; i < 1105; i += 1)
      server.changes.push({
        seq: i,
        tbl: 'products',
        op: 'upsert',
        row: product(`q${i}`),
      });
    await pullAll(db);
    expect(await getKv(db, 'pull_cursor', 0)).toBe(1104);
    expect((await db.categories.get('c-local'))?.name_en).toBe('Mine');
    expect(
      (await db.pull_shadow.get(['categories', 'c-local']))?.row.name_en,
    ).toBe('Server');
    expect((await db.stock_levels.get('p1'))?.on_hand_milli).toBe(5000);
    expect(await db.products.count()).toBe(1101);
    expect(server.log.filter((l) => l.path === '/sync/pull')).toHaveLength(3);
    // The same ledger row again does not double-count.
    server.changes.push({
      seq: 2000,
      tbl: 'stock_movements',
      op: 'upsert',
      row: {
        id: 'sm1',
        product_id: 'p1',
        qty_delta_milli: 5000,
        created_at: 1,
      },
    });
    await pullAll(db);
    expect((await db.stock_levels.get('p1'))?.on_hand_milli).toBe(5000);
    expect(await getKv(db, 'restore_epoch', null)).toBe('1');
  });

  it('quarantines a malformed row and a unique collision without wedging the cursor', async () => {
    const db = await enrolled('pull-bad');
    server.changes = [
      {
        seq: 1,
        tbl: 'products',
        op: 'upsert',
        row: { ...product('p1'), price: { bad: true } } as never,
      },
      {
        seq: 10,
        tbl: 'products',
        op: 'upsert',
        row: { ...product('p-missing'), id: '' } as never,
      },
      {
        seq: 11,
        tbl: 'products',
        op: 'upsert',
        row: { ...product('p-long'), notes: 'x'.repeat(4_001) } as never,
      },
      {
        seq: 12,
        tbl: 'products',
        op: 'upsert',
        row: { ...product('p-float'), price: 1.5 } as never,
      },
      { seq: 2, tbl: 'products', op: 'upsert', row: product('p2') },
      {
        seq: 3,
        tbl: 'sale_voids',
        op: 'upsert',
        row: {
          id: 'void-1',
          sale_id: 'sale-1',
          reason: 'x',
          created_at: 1,
        },
      },
      {
        seq: 4,
        tbl: 'sale_voids',
        op: 'upsert',
        row: {
          id: 'void-2',
          sale_id: 'sale-1',
          reason: 'y',
          created_at: 1,
        },
      },
    ];
    await pullAll(db);
    expect(await db.products.get('p2')).toBeDefined();
    expect(await getKv(db, 'pull_cursor', 0)).toBe(4);
    const errors = await getKv<unknown[]>(db, 'pull_errors', []);
    expect(errors).toHaveLength(5);
  });

  it('410 SNAPSHOT_REQUIRED runs a resumable snapshot, then continues from snapshot_seq', async () => {
    const db = await enrolled('snap');
    server.floor = 50;
    server.tables = {
      products: Array.from({ length: 1200 }, (_, i) =>
        product(`p${String(i).padStart(4, '0')}`),
      ),
      stock_movements: [
        {
          id: 'sm1',
          product_id: 'p0001',
          qty_delta_milli: 3000,
          created_at: 1,
        },
      ],
    };
    server.snapshotSeq = 55;
    server.changes = [
      {
        seq: 60,
        tbl: 'products',
        op: 'upsert',
        row: product('p0001', { name_en: 'Latest' }),
      },
    ];
    const seen: number[] = [];
    // Fail after the second snapshot page to prove resume.
    let pages = 0;
    server.override = ({ path, query }) => {
      if (path === '/sync/snapshot' && query.get('tbl')) {
        pages += 1;
        if (pages === 2)
          return {
            status: 503,
            json: { error: { code: 'INTERNAL', message: 'x' } },
          };
      }
      return undefined;
    };
    await expect(pullAll(db, (d) => seen.push(d))).rejects.toBeInstanceOf(
      SyncHttpError,
    );
    expect(await getKv(db, 'snapshot_state', null)).toMatchObject({
      index: 0,
      after: 'p0499',
    });
    server.override = null;
    await pullAll(db, (d) => seen.push(d));
    expect(await db.products.count()).toBe(1200);
    expect((await db.products.get('p0001'))?.name_en).toBe('Latest');
    expect((await db.stock_levels.get('p0001'))?.on_hand_milli).toBe(3000);
    expect(await getKv(db, 'snapshot_state', null)).toBeNull();
    expect(await getKv(db, 'pull_cursor', 0)).toBe(60);
    expect(seen.at(-1)).toBe(1201);
  });

  it('quarantines a snapshot row and lets the server void win a sale_id collision', async () => {
    const db = await enrolled('snap-void');
    const local = {
      id: 'local-void',
      sale_id: 'sale-1',
      reason: 'local',
      replacement_sale_id: null,
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: '2026-10-27',
      created_at: NOW,
    };
    await db.sale_voids.add(local);
    await db.outbox.add({
      op_id: newId(),
      tx_id: newId(),
      tbl: 'sale_voids',
      kind: 'insert',
      row_id: 'local-void',
      row: local,
      status: 'pending',
      attempts: 0,
      created_at: NOW,
    });
    server.tables = {
      sale_voids: [
        {
          id: 'server-void',
          sale_id: 'sale-1',
          reason: 'server',
          replacement_sale_id: null,
          device_id: 'dev-1',
          staff_id: 'st-1',
          business_date: '2026-10-27',
          created_at: NOW + 1,
        },
      ],
    };
    server.snapshotSeq = 70;
    await runSnapshot(db);
    expect(await db.sale_voids.get('server-void')).toMatchObject({
      reason: 'server',
    });
    expect(await db.sale_voids.get('local-void')).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
    expect(await getKv(db, 'snapshot_state', null)).toBeNull();
    expect(await getKv(db, 'pull_cursor', 0)).toBe(70);
  });

  it('restore recovery re-sends own ledger rows since the restore point and re-downloads', async () => {
    const db = await enrolled('restore');
    await setKv(db, 'restore_epoch', '1');
    await setKv(db, 'invoice_seq', 3);
    await db.sales.bulkAdd([
      {
        id: 's-old',
        device_id: 'dev-1',
        invoice_seq: 1,
        invoice_no: 'A-A-1',
        created_at: NOW - 1000,
      },
      {
        id: 's-new',
        device_id: 'dev-1',
        invoice_seq: 7,
        invoice_no: 'A-A-7',
        created_at: NOW + 1000,
      },
      {
        id: 's-other',
        device_id: 'dev-2',
        invoice_seq: 1,
        invoice_no: 'A-B-1',
        created_at: NOW + 1000,
      },
    ]);
    await db.sale_lines.bulkAdd([
      { id: 'l-old', sale_id: 's-old', created_at: NOW - 1000 },
      { id: 'l-new', sale_id: 's-new', created_at: NOW + 1000 },
    ]);
    server.restoreEpoch = '99';
    server.restorePointAt = NOW + 1;
    server.tables = {
      sales: [
        {
          id: 's-old',
          device_id: 'dev-1',
          invoice_seq: 1,
          invoice_no: 'A-A-1',
          created_at: 100,
        },
      ],
    };
    await pullAll(db);
    const resent = await db.outbox.toArray();
    expect(resent.map((e) => e.row_id)).toEqual(['s-new', 'l-new']);
    expect(resent[0]?.kind).toBe('insert');
    // The restored snapshot has s-old; the recovered s-new is replayed locally at once.
    expect(await db.sales.count()).toBe(2);
    expect((await db.sales.get('s-old'))?.invoice_no).toBe('A-A-1');
    expect((await db.sales.get('s-new'))?.invoice_no).toBe('A-A-7');
    expect(await getKv(db, 'restore_epoch', null)).toBe('99');
    expect(await getKv(db, 'invoice_seq', 0)).toBe(7);
    await db.sales.put({
      id: 's-9',
      device_id: 'dev-1',
      invoice_seq: 9,
      invoice_no: 'A-A-9',
      created_at: 1,
    });
    await fixInvoiceSeq(db);
    expect(await getKv(db, 'invoice_seq', 0)).toBe(9);
    await restoreRecovery(db, 0, '99');
    expect(
      (await db.outbox.toArray()).filter((e) => e.row_id === 's-9'),
    ).toHaveLength(1);
  });

  it('does not re-queue a ledger row that is already pending in the outbox', async () => {
    const db = await enrolled('restore-queued');
    await setKv(db, 'restore_epoch', '1');
    const row = {
      id: 's-pending',
      device_id: 'dev-1',
      invoice_seq: 5,
      invoice_no: 'A-A-5',
      created_at: NOW + 1000,
    };
    await db.sales.add(row);
    await db.outbox.add({
      op_id: newId(),
      tx_id: newId(),
      tbl: 'sales',
      kind: 'insert',
      row_id: 's-pending',
      row,
      status: 'pending',
      attempts: 0,
      created_at: NOW + 1000,
    });
    server.restoreEpoch = '99';
    server.restorePointAt = NOW + 1;
    server.tables = { sales: [] };
    await pullAll(db);
    const queued = (await db.outbox.toArray()).filter(
      (entry) => entry.row_id === 's-pending',
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.recovery).not.toBe(true);
  });

  it('groups restore recovery by document and keeps the snapshot state', async () => {
    const db = await enrolled('restore-groups');
    const base = {
      device_id: 'dev-1',
      branch_id: 'br-1',
      staff_id: 'st-1',
      business_date: '2026-10-27',
      created_at: 1000,
    };
    const saleId = 's1';
    const refundId = 'r1';
    const voidId = 'v1';
    const purchaseId = 'p1';
    const returnId = 'sr1';
    await db.sales.add({
      ...base,
      id: saleId,
      invoice_no: 'A-A-1',
      invoice_seq: 1,
    });
    await db.sale_lines.add({
      id: 'sl1',
      sale_id: saleId,
      product_id: 'prod-1',
      created_at: 1000,
    });
    await db.payments.bulkAdd([
      { id: 'pay-sale', sale_id: saleId, purpose: 'sale', created_at: 1000 },
      {
        id: 'pay-refund',
        // The real refund writer sets both ids; the refund document must own the payment.
        sale_id: saleId,
        refund_id: refundId,
        purpose: 'refund',
        created_at: 1000,
      },
      {
        id: 'pay-purchase',
        purchase_id: purchaseId,
        purpose: 'purchase_paid_now',
        created_at: 1000,
      },
      {
        id: 'pay-return',
        supplier_return_id: returnId,
        purpose: 'supplier_refund',
        created_at: 1000,
      },
      {
        id: 'pay-void',
        sale_id: saleId,
        purpose: 'void',
        created_at: 1000,
      },
    ] as never);
    await db.refunds.add({
      id: refundId,
      sale_id: saleId,
      created_at: 1000,
    });
    await db.refund_lines.add({
      id: 'rl1',
      refund_id: refundId,
      sale_line_id: 'sl1',
      created_at: 1000,
    });
    await db.sale_voids.add({
      id: voidId,
      sale_id: saleId,
      created_at: 1000,
    });
    await db.purchases.add({
      id: purchaseId,
      created_at: 1000,
      business_date: '2026-10-27',
    });
    await db.purchase_lines.add({
      id: 'pl1',
      purchase_id: purchaseId,
      created_at: 1000,
    });
    await db.supplier_returns.add({
      id: returnId,
      created_at: 1000,
      business_date: '2026-10-27',
    });
    await db.supplier_return_lines.add({
      id: 'srl1',
      return_id: returnId,
      created_at: 1000,
    });
    await db.ledger_entries.bulkAdd([
      {
        id: 'l-sale',
        source_type: 'sale',
        source_id: saleId,
        created_at: 1000,
      },
      {
        id: 'l-refund',
        source_type: 'refund',
        source_id: refundId,
        created_at: 1000,
      },
      {
        id: 'l-void',
        source_type: 'void',
        source_id: voidId,
        created_at: 1000,
      },
      {
        id: 'l-pay',
        source_type: 'payment',
        source_id: 'pay-sale',
        created_at: 1000,
      },
      {
        id: 'l-purchase',
        source_type: 'purchase',
        source_id: purchaseId,
        created_at: 1000,
      },
      {
        id: 'l-return',
        source_type: 'supplier_return',
        source_id: returnId,
        created_at: 1000,
      },
      {
        id: 'l-adjust',
        source_type: 'adjustment',
        source_id: null,
        created_at: 1000,
      },
    ] as never);
    await db.stock_movements.bulkAdd([
      {
        id: 'm-sale',
        reason_code: 'sale',
        ref_id: saleId,
        product_id: 'prod-1',
        created_at: 1000,
      },
      {
        id: 'm-refund',
        reason_code: 'refund_return',
        ref_id: refundId,
        product_id: 'prod-1',
        created_at: 1000,
      },
      {
        id: 'm-void',
        reason_code: 'void_return',
        ref_id: voidId,
        product_id: 'prod-1',
        created_at: 1000,
      },
      {
        id: 'm-purchase',
        reason_code: 'purchase',
        ref_id: purchaseId,
        product_id: 'prod-1',
        created_at: 1000,
      },
      {
        id: 'm-return',
        reason_code: 'supplier_return',
        ref_id: returnId,
        product_id: 'prod-1',
        created_at: 1000,
      },
      {
        id: 'm-count',
        reason_code: 'count',
        ref_id: null,
        product_id: 'prod-1',
        created_at: 1000,
      },
    ] as never);
    await db.expenses.add({
      id: 'e1',
      created_at: 1000,
      business_date: '2026-10-27',
    });
    await db.cash_moves.add({ id: 'cm1', created_at: 1000 });
    await db.day_closes.add({
      id: 'dc1',
      device_id: 'dev-1',
      period_end: 1000,
      business_date: '2026-10-27',
      created_at: 1000,
    });
    await db.audit_log.bulkAdd([
      {
        id: 'a-void',
        entity: 'sale_voids',
        entity_id: voidId,
        created_at: 1000,
      },
      {
        id: 'a-refund',
        entity: 'refunds',
        entity_id: refundId,
        created_at: 1000,
      },
      { id: 'a-sale', entity: 'sales', entity_id: saleId, created_at: 1000 },
      {
        id: 'a-expense',
        entity: 'expenses',
        entity_id: 'e1',
        created_at: 1000,
      },
      { id: 'a-other', entity: 'staff', entity_id: 'st-1', created_at: 1000 },
    ] as never);

    // Ledger rows are caches' source of truth; give the synthetic rows the fields a
    // real write always has so the replay after restore can rebuild balances.
    await db.ledger_entries
      .toCollection()
      .modify({ amount: 100, party_type: 'customer', party_id: 'c1' });
    for (const tbl of [
      'payments',
      'refunds',
      'sale_voids',
      'purchases',
      'supplier_returns',
      'ledger_entries',
      'stock_movements',
      'expenses',
      'cash_moves',
      'day_closes',
      'audit_log',
    ] as const)
      await db.table(tbl).toCollection().modify({ device_id: 'dev-1' });
    server.tables = {};
    await restoreRecovery(db, 500, 'epoch-2');
    const queued = await db.outbox.toArray();
    expect(new Set(queued.map((op) => op.tbl)).size).toBeGreaterThan(8);
    // A refund payment must travel with its refund, not with the original sale.
    const refundTx = queued.find(
      (op) => op.tbl === 'refunds' && op.row_id === refundId,
    )?.tx_id;
    expect(refundTx).toBeDefined();
    for (const rowId of ['pay-refund', 'rl1', 'l-refund', 'm-refund'])
      expect(queued.find((op) => op.row_id === rowId)?.tx_id).toBe(refundTx);
    const perTx = new Map<string, number>();
    for (const op of queued)
      perTx.set(op.tx_id, (perTx.get(op.tx_id) ?? 0) + 1);
    expect(Math.max(...perTx.values())).toBeLessThanOrEqual(200);
    expect(await getKv(db, 'restore_epoch', null)).toBe('epoch-2');
    expect(await getKv(db, 'snapshot_state', null)).toBeNull();
    // Recovery replays the rows it queued so the till is usable before the next push.
    expect(await db.sales.count()).toBe(1);
    expect(await db.sale_voids.count()).toBe(1);
  });

  it('restore recovery re-sends master rows created or changed after the restore point', async () => {
    const db = await enrolled('restore-master');
    const later = NOW + 1000;
    await db.staff.add({
      id: 'st-new',
      name: 'New cashier',
      role: 'cashier',
      active: 1,
      permissions_json: '{}',
      created_at: later,
      updated_at: later,
      deleted_at: null,
      rev: 1,
      updated_by: 'st-1',
    });
    await db.customers.bulkAdd([
      {
        id: 'c-new',
        name: 'New customer',
        phone: '',
        created_at: later,
        updated_at: later,
        deleted_at: null,
        rev: 1,
        updated_by: 'st-new',
      },
      {
        id: 'c-old',
        name: 'Old customer',
        phone: '',
        created_at: NOW - 1000,
        updated_at: NOW - 1000,
        deleted_at: null,
        rev: 1,
        updated_by: 'st-1',
      },
      {
        id: 'c-queued',
        name: 'Queued customer',
        phone: '',
        created_at: later,
        updated_at: later,
        deleted_at: null,
        rev: 1,
        updated_by: 'st-1',
      },
    ]);
    await db.products.add({
      id: 'p-new',
      name_en: 'New product',
      price: 100,
      created_at: later,
      updated_at: later,
      deleted_at: null,
      rev: 1,
      updated_by: 'st-new',
    });
    await db.suppliers.add({
      id: 'sup-del',
      name: 'Deleted supplier',
      phone: '',
      created_at: NOW - 1000,
      updated_at: later,
      deleted_at: later,
      rev: 2,
      updated_by: 'st-1',
    });
    await db.outbox.add({
      op_id: 'op-queued',
      tx_id: 'tx-queued',
      tbl: 'customers',
      kind: 'upsert',
      row_id: 'c-queued',
      row: { id: 'c-queued', name: 'Queued customer' },
      base_rev: 1,
      changed_fields: ['name'],
      created_at: later,
      status: 'pending',
      attempts: 0,
    });
    await db.ledger_entries.bulkAdd([
      {
        id: 'l-open-new',
        party_type: 'customer',
        party_id: 'c-new',
        amount: 5000,
        source_type: 'opening',
        source_id: null,
        staff_id: 'st-new',
        device_id: 'dev-1',
        created_at: later,
      },
      {
        id: 'l-open-old',
        party_type: 'customer',
        party_id: 'c-old',
        amount: 7000,
        source_type: 'opening',
        source_id: null,
        staff_id: 'st-1',
        device_id: 'dev-1',
        created_at: later,
      },
      {
        id: 'l-sale',
        party_type: 'customer',
        party_id: 'c-new',
        amount: 1000,
        source_type: 'sale',
        source_id: 's-new',
        staff_id: 'st-new',
        device_id: 'dev-1',
        created_at: later,
      },
    ] as never);
    await db.sales.add({
      id: 's-new',
      invoice_no: 'A-A-1',
      invoice_seq: 1,
      device_id: 'dev-1',
      staff_id: 'st-new',
      created_at: later,
    });
    await db.sale_lines.add({
      id: 'sl-new',
      sale_id: 's-new',
      product_id: 'p-new',
      created_at: later,
    });
    await db.payments.add({
      id: 'pay-new',
      sale_id: 's-new',
      purpose: 'sale',
      amount: 1000,
      staff_id: 'st-new',
      device_id: 'dev-1',
      created_at: later,
    });
    server.tables = {};
    await restoreRecovery(db, NOW + 1, 'epoch-3');

    const outbox = await db.outbox.toArray();
    const byRow = (id: string) => outbox.filter((entry) => entry.row_id === id);
    expect(byRow('c-new')).toHaveLength(1);
    expect(byRow('c-new')[0]).toMatchObject({
      kind: 'upsert',
      tbl: 'customers',
    });
    expect(byRow('p-new')).toHaveLength(1);
    expect(byRow('sup-del')[0]).toMatchObject({
      kind: 'delete',
      tbl: 'suppliers',
    });
    // A row already queued keeps its original op and is not queued twice.
    expect(byRow('c-queued')).toHaveLength(1);
    expect(byRow('c-queued')[0]?.op_id).toBe('op-queued');
    // The opening balance, its party and the new cashier share one transaction.
    const openingTx = byRow('l-open-new')[0]?.tx_id;
    expect(byRow('c-new').some((entry) => entry.tx_id === openingTx)).toBe(
      true,
    );
    expect(byRow('st-new').some((entry) => entry.tx_id === openingTx)).toBe(
      true,
    );
    // An older party is pulled into the opening transaction but not re-sent alone.
    const oldTx = byRow('l-open-old')[0]?.tx_id;
    expect(byRow('c-old').some((entry) => entry.tx_id === oldTx)).toBe(true);
    // The sale document keeps its lines and payment together with its cashier.
    const saleTx = byRow('s-new')[0]?.tx_id;
    expect(byRow('sl-new').some((entry) => entry.tx_id === saleTx)).toBe(true);
    expect(byRow('pay-new').some((entry) => entry.tx_id === saleTx)).toBe(true);
    expect(byRow('st-new').some((entry) => entry.tx_id === saleTx)).toBe(true);
  });

  it('narrows recovered master edits to the fields that differ from the restored row', async () => {
    const db = await readyDb('recover-master');
    await db.customers.put({
      id: 'c1',
      name: 'Restored',
      phone: '0300',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 2,
      updated_by: null,
    } as never);
    await db.customers.put({
      id: 'c-newer',
      name: 'Restored newer',
      phone: '0301',
      created_at: NOW,
      updated_at: NOW + 1000,
      deleted_at: null,
      rev: 3,
      updated_by: null,
    } as never);
    await db.outbox.bulkAdd([
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'customers',
        kind: 'upsert',
        row_id: 'c1',
        row: { id: 'c1', name: 'Mine', phone: '0300' },
        base_rev: 2,
        changed_fields: ['name', 'phone'],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'customers',
        kind: 'upsert',
        row_id: 'c-new',
        row: { id: 'c-new', name: 'New' },
        base_rev: 0,
        changed_fields: ['name'],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'customers',
        kind: 'upsert',
        row_id: 'c-ordinary',
        row: { id: 'c-ordinary', name: 'Ordinary', phone: '1' },
        base_rev: 0,
        changed_fields: ['name', 'phone'],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'customers',
        kind: 'upsert',
        row_id: 'c-no-row',
        base_rev: 0,
        changed_fields: ['name'],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'customers',
        kind: 'upsert',
        row_id: 'c-newer',
        row: {
          id: 'c-newer',
          name: 'Old local',
          phone: '0301',
          updated_at: NOW,
        },
        base_rev: 2,
        changed_fields: ['name'],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
    ] as never);
    await reconcileRecoveredMasterFields(db);
    const entries = await db.outbox.toArray();
    expect(entries[0]?.changed_fields).toEqual(['name']);
    // No server copy for a row created after the restore point: keep the full upsert.
    expect(entries[1]?.changed_fields).toEqual(['name']);
    expect(entries[2]?.changed_fields).toEqual(['name', 'phone']);
    expect(entries[3]?.changed_fields).toEqual(['name']);
    // The restored row is newer than this local edit, so another till already won.
    expect(entries[4]?.changed_fields).toEqual([]);
    // Restore cleared the old shadow; recovered edits must get a new one so a later
    // rejection can be discarded back to the restored row.
    expect(await db.pull_shadow.get(['customers', 'c1'])).toBeDefined();
    expect(await db.pull_shadow.get(['customers', 'c-new'])).toBeUndefined();
  });

  it('replays recovered deletes and master inserts locally', async () => {
    const db = await readyDb('replay-delete');
    await db.categories.put({
      id: 'c-old',
      name_en: 'Old',
      name_ur: '',
      color: 't1',
      sort_order: 0,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    } as never);
    await db.categories.put({
      id: 'c-existing',
      name_en: 'Before',
      name_ur: '',
      color: 't1',
      sort_order: 0,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 4,
      updated_by: null,
    } as never);
    await db.outbox.bulkAdd([
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'categories',
        kind: 'upsert',
        row_id: 'c-existing',
        row: { id: 'c-existing', name_en: 'After' },
        base_rev: 4,
        changed_fields: ['name_en'],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'categories',
        kind: 'delete',
        row_id: 'c-old',
        base_rev: 1,
        updated_by: null,
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'categories',
        kind: 'upsert',
        row_id: 'c-new',
        row: { id: 'c-new', name_en: 'New', code: 'new' },
        base_rev: 0,
        changed_fields: [],
        created_at: NOW,
        status: 'pending',
        attempts: 0,
        recovery: true,
      },
      {
        op_id: newId(),
        tx_id: newId(),
        tbl: 'categories',
        kind: 'upsert',
        row_id: 'c-failed',
        row: { id: 'c-failed', name_en: 'Rejected' },
        base_rev: 0,
        changed_fields: [],
        created_at: NOW,
        status: 'failed',
        attempts: 1,
      },
    ] as never);
    await replayOutboxLocally(db);
    expect((await db.categories.get('c-old'))?.deleted_at).toBe(NOW);
    expect((await db.categories.get('c-new'))?.name_en).toBe('New');
    expect((await db.categories.get('c-existing'))?.name_en).toBe('After');
    expect((await db.categories.get('c-existing'))?.rev).toBe(4);
    expect(await db.categories.get('c-failed')).toBeUndefined();
  });

  it('runSnapshot from scratch on a new device', async () => {
    const db = await enrolled('fresh');
    server.tables = { shop: [{ id: 'shop', name: 'S' }] };
    await runSnapshot(db);
    expect((await db.shop.get('shop'))?.name).toBe('S');
  });
});

describe('status, me and engine (03 §6–7)', () => {
  it('applyStatus stores read-only once with learned_at, support and poll interval', async () => {
    const db = await enrolled('st');
    await applyStatus(
      db,
      {
        tenant_status: { status: 'read_only', since: 5 },
        support: { until: 9, reason: 'r' },
        poll_after_ms: 120_000,
      },
      1000,
    );
    await applyStatus(
      db,
      { tenant_status: { status: 'read_only', since: 5 } },
      2000,
    );
    expect(await getKv(db, 'tenant_status', null)).toEqual({
      status: 'read_only',
      since: 5,
      learned_at: 1000,
    });
    expect(await isReadOnly(db)).toBe(true);
    expect(await getKv(db, 'poll_after_ms', 0)).toBe(120_000);
    expect(await getKv(db, 'support', null)).toEqual({ until: 9, reason: 'r' });
  });

  it('refreshMe picks up a new device code after a branch move', async () => {
    const db = await enrolled('me');
    server.device = { ...server.device, device_code: 'C', branch_id: 'br-2' };
    await refreshMe(db);
    expect(await getKv(db, 'device', null)).toMatchObject({
      code: 'C',
      branch_id: 'br-2',
    });
  });

  it('engine: first run syncs, revoked stops, quota waits, offline backs off', async () => {
    const db = await enrolled('eng');
    expect(backoffDelay(1)).toBe(5_000);
    expect(backoffDelay(9)).toBe(300_000);
    const engine = await SyncEngine.start(db);
    expect(engine).not.toBeNull();
    await syncNow();
    await vi.waitFor(() => expect(useSyncState.getState().phase).toBe('idle'));
    expect(useSyncState.getState().lastSyncAt).not.toBeNull();
    expect(server.log.some((l) => l.path === '/me')).toBe(true);

    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 503,
            json: { error: { code: 'TENANT_QUOTA', message: 'q' } },
            headers: { 'retry-after': '60' },
          }
        : undefined;
    await writeAction(db, (w) => w.create('categories', { name_en: 'Q' }));
    await engine?.run('full');
    expect(useSyncState.getState().phase).toBe('quota');
    expect(useSyncState.getState().quotaUntil).toBeGreaterThan(Date.now());
    // The account-wide D1 limit waits the same way (04 §3).
    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 503,
            json: { error: { code: 'D1_LIMIT', message: 'd1' } },
            headers: { 'retry-after': '120' },
          }
        : undefined;
    useSyncState.getState().set({ phase: 'idle', quotaUntil: null });
    await engine?.run('full');
    expect(useSyncState.getState().phase).toBe('quota');

    server.tenantStatus = { status: 'read_only', since: 7 };
    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 403,
            json: {
              error: {
                code: 'TENANT_READ_ONLY',
                message: 'ro',
                details: { since: 7 },
              },
            },
          }
        : undefined;
    await engine?.run('full');
    expect(await isReadOnly(db)).toBe(true);
    expect(await db.outbox.where('status').equals('pending').count()).toBe(1);

    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 403,
            json: { error: { code: 'TENANT_SUSPENDED', message: 's' } },
          }
        : undefined;
    await engine?.run('full');
    expect(useSyncState.getState().phase).toBe('suspended');

    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 500,
            json: { error: { code: 'INTERNAL', message: 'boom' } },
          }
        : undefined;
    await engine?.run('push');
    expect(useSyncState.getState().phase).toBe('error');

    server.override = null;
    server.online = false;
    await engine?.run('full');
    expect(useSyncState.getState().phase).toBe('offline');
    server.online = true;

    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 409,
            json: { error: { code: 'SCHEMA_OUTDATED', message: 'o' } },
          }
        : undefined;
    await engine?.run('full');
    expect(useSyncState.getState().phase).toBe('outdated');
    useSyncState.getState().set({ phase: 'idle' });

    server.override = ({ path }) =>
      path === '/sync/push'
        ? {
            status: 401,
            json: { error: { code: 'DEVICE_REVOKED', message: 'r' } },
          }
        : undefined;
    await engine?.run('full');
    expect(useSyncState.getState().phase).toBe('revoked');
    expect(await getKv(db, 'revoked', null)).toMatchObject({
      code: 'DEVICE_REVOKED',
    });
    engine?.stop();
    notifyLocalWrite();
  });

  it('engine does not start without a token; write debounce pushes after 5 s', async () => {
    const plain = await readyDb('notoken');
    expect(await SyncEngine.start(plain)).toBeNull();
    const db = await enrolled('debounce');
    const engine = await SyncEngine.start(db);
    await syncNow();
    server.log = [];
    await writeAction(db, (w) => w.create('categories', { name_en: 'D' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    notifyLocalWrite();
    expect(server.log).toHaveLength(0);
    vi.advanceTimersByTime(5_100);
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(server.log.some((l) => l.path === '/sync/push')).toBe(true),
    );
    engine?.stop();
  });
});

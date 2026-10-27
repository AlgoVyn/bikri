import type { OutboxEntry } from '@bikri/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKv, setKv } from '../data/kv.ts';
import { dropTestDbs } from '../data/testDb.ts';
import { readyDb } from '../data/testShop.ts';
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
    expect(body).toMatchObject({ device_id: 'dev-1', schema_version: 1 });
    // A failed op is not pushed again until Retry.
    server.log = [];
    await pushAll(db);
    expect(server.log).toHaveLength(0);
    await retryFailed(db, [left[0]?.seq ?? 0]);
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
        created_at: 100,
      },
      {
        id: 's-new',
        device_id: 'dev-1',
        invoice_seq: 7,
        invoice_no: 'A-A-7',
        created_at: 900,
      },
      {
        id: 's-other',
        device_id: 'dev-2',
        invoice_seq: 1,
        invoice_no: 'A-B-1',
        created_at: 900,
      },
    ]);
    server.restoreEpoch = '99';
    server.restorePointAt = 500;
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
    expect(resent.map((e) => e.row_id)).toEqual(['s-new']);
    expect(resent[0]?.kind).toBe('insert');
    expect(await db.sales.count()).toBe(1);
    expect(await getKv(db, 'restore_epoch', null)).toBe('99');
    expect(await getKv(db, 'invoice_seq', 0)).toBe(3);
    await db.sales.put({
      id: 's-9',
      device_id: 'dev-1',
      invoice_seq: 9,
      invoice_no: 'A-A-9',
      created_at: 1,
    });
    await fixInvoiceSeq(db);
    expect(await getKv(db, 'invoice_seq', 0)).toBe(9);
    await restoreRecovery(db, 0);
    expect(
      (await db.outbox.toArray()).filter((e) => e.row_id === 's-9'),
    ).toHaveLength(1);
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

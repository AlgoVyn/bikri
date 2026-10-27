import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_TABLES } from '../../src/sync/tables.ts';
import {
  addSupportDevice,
  api,
  IDS,
  json,
  seedShop,
  setStatus,
} from '../helpers/fixtures.ts';
import {
  op,
  productRow,
  pullAll,
  push,
  pushOk,
  saleOps,
} from '../helpers/ops.ts';

// Cross-tenant isolation of sync (10 §8 I1–I6, I13, I14, I21, I24; 03 §9 cases 21–25).

async function snapshotRows(
  token: string,
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const tbl of SNAPSHOT_TABLES) {
    const rows: Array<Record<string, unknown>> = [];
    let after = '';
    for (;;) {
      const res = await api(
        `/sync/snapshot?tbl=${tbl}&after=${after}&limit=1000`,
        { token },
      );
      const body = await json<{
        rows: Array<Record<string, unknown>>;
        next_after: string;
        has_more: boolean;
      }>(res);
      rows.push(...body.rows);
      after = body.next_after;
      if (!body.has_more) break;
    }
    out.set(tbl, rows);
  }
  return out;
}

describe('sync isolation', () => {
  it('I1 / 21: B pulls and snapshots only B rows, never A rows and never tenant_id', async () => {
    const a = await seedShop('Iso A');
    const b = await seedShop('Iso B');
    await pushOk(a.till, saleOps(a, a.till, 1));
    await pushOk(b.till, saleOps(b, b.till, 1));
    const changes = await pullAll(b.till);
    for (const c of changes) expect(c.row).not.toHaveProperty('tenant_id');
    const aSales = await env.DB.prepare(
      'SELECT id FROM sales WHERE tenant_id = ?1',
    )
      .bind(a.tenantId)
      .all<{ id: string }>();
    const aIds = new Set(aSales.results.map((r) => r.id));
    expect(changes.some((c) => aIds.has(String(c.row.id)))).toBe(false);
    const snap = await snapshotRows(b.till.token);
    for (const [tbl, rows] of snap) {
      const own = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${tbl} WHERE tenant_id = ?1`,
      )
        .bind(b.tenantId)
        .first<{ n: number }>();
      expect(rows.length, tbl).toBe(own?.n);
      for (const r of rows) expect(r).not.toHaveProperty('tenant_id');
    }
    expect(snap.get('products')?.[0]?.name_en).toBe('Iso B phone');
    expect(snap.get('sales')?.some((r) => aIds.has(String(r.id)))).toBe(false);
  });

  it('I2: B upserts a product id that exists in A → only B changes; A byte-identical', async () => {
    const a = await seedShop('Up A');
    const b = await seedShop('Up B');
    const before = await env.DB.prepare(
      'SELECT * FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, IDS.product)
      .first();
    const res = await pushOk(b.admin, [
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          sku: 'PHN-0001',
          price: 1,
          name_en: 'B edit',
        }),
        {
          base_rev: 3,
          changed_fields: ['price', 'name_en'],
        },
      ),
    ]);
    expect(res.results[0]?.result).toBe('applied');
    const after = await env.DB.prepare(
      'SELECT * FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, IDS.product)
      .first();
    expect(after).toEqual(before);
    const bRow = await env.DB.prepare(
      'SELECT name_en FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(b.tenantId, IDS.product)
      .first();
    expect(bRow).toEqual({ name_en: 'B edit' });
    // a brand-new id that exists only in A is created in B
    const onlyA = newId();
    await env.DB.prepare(
      "INSERT INTO products (tenant_id, id, name_en, sku, price, created_at, updated_at) VALUES (?1, ?2, 'A only', 'AONLY', 5, 1, 1)",
    )
      .bind(a.tenantId, onlyA)
      .run();
    const created = await pushOk(b.admin, [
      op(
        'products',
        'upsert',
        productRow(onlyA, { sku: 'BNEW', name_en: 'B new' }),
      ),
    ]);
    expect(created.results[0]).toMatchObject({
      result: 'applied',
      server_rev: 1,
    });
    expect(
      await env.DB.prepare(
        'SELECT name_en FROM products WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(a.tenantId, onlyA)
        .first(),
    ).toEqual({ name_en: 'A only' });
  });

  it('I3 / I11: B ledger rows referencing A-only ids → rejected FOREIGN_KEY, same answer as unknown ids', async () => {
    const a = await seedShop('Fk A');
    const b = await seedShop('Fk B');
    const aCustomer = newId();
    await env.DB.prepare(
      "INSERT INTO customers (tenant_id, id, name, created_at, updated_at) VALUES (?1, ?2, 'A only', 1, 1)",
    )
      .bind(a.tenantId, aCustomer)
      .run();
    const withA = saleOps(b, b.till, 1, { customerId: aCustomer });
    const withUnknown = saleOps(b, b.till, 2, { customerId: newId() });
    const r1 = await pushOk(b.till, withA);
    const r2 = await pushOk(b.till, withUnknown);
    expect(r1.results.map((r) => [r.result, r.error_code])).toEqual([
      ['rejected', 'FOREIGN_KEY'],
      ['rejected', 'FOREIGN_KEY'],
    ]);
    expect(r2.results.map((r) => r.error_code)).toEqual(
      r1.results.map((r) => r.error_code),
    );
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
      )
        .bind(b.tenantId)
        .first(),
    ).toEqual({ n: 0 });
    // A's branch id in a B movement
    const move = op('stock_movements', 'insert', {
      id: newId(),
      product_id: IDS.product,
      qty_delta_milli: 1000,
      reason_code: 'received_local',
      ref_type: 'adjustment',
      ref_id: null,
      unit_cost: 100,
      note: '',
      branch_id: a.branchId,
      device_id: b.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
    });
    const r3 = await pushOk(b.till, [move]);
    expect(r3.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'FOREIGN_KEY',
    });
  });

  it('I4: a tenant_id key inside a B row is ignored; the row lands in B', async () => {
    const a = await seedShop('Key A');
    const b = await seedShop('Key B');
    const id = newId();
    const res = await pushOk(b.admin, [
      op('products', 'upsert', {
        ...productRow(id, { sku: 'KEY-1' }),
        tenant_id: a.tenantId,
      }),
    ]);
    expect(res.results[0]?.result).toBe('applied');
    expect(
      await env.DB.prepare('SELECT tenant_id FROM products WHERE id = ?1')
        .bind(id)
        .all(),
    ).toMatchObject({
      results: [{ tenant_id: b.tenantId }],
    });
  });

  it('I5 + I6: same op_id, SKU, barcode, bill prefix and INV-A-1 in A and B are all accepted', async () => {
    const a = await seedShop('Same A');
    const b = await seedShop('Same B');
    const ops = saleOps(a, a.admin, 1);
    const bOps = saleOps(b, b.admin, 1).map((o, i) => ({
      ...o,
      op_id: ops[i]?.op_id ?? o.op_id,
    }));
    expect((await pushOk(a.admin, ops)).results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
    ]);
    expect((await pushOk(b.admin, bOps)).results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
    ]);
    const invoices = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sales WHERE invoice_no = 'INV-A-1' AND tenant_id IN (?1, ?2)",
    )
      .bind(a.tenantId, b.tenantId)
      .first();
    expect(invoices).toEqual({ n: 2 });
    // uniqueness still enforced inside a tenant
    const dupSku = await pushOk(b.admin, [
      op('products', 'upsert', productRow(newId(), { sku: 'PHN-0001' })),
    ]);
    expect(dupSku.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'UNIQUE_VIOLATION',
    });
  });

  it('I13 / 22: a new restore_epoch for A changes only A pull responses', async () => {
    const a = await seedShop('Epoch A');
    const b = await seedShop('Epoch B');
    await env.DB.prepare(
      "UPDATE tenants SET restore_epoch = 'new-epoch', restore_point_at = 5 WHERE id = ?1",
    )
      .bind(a.tenantId)
      .run();
    const pa = await json<{ restore_epoch: string; restore_point_at: number }>(
      await api('/sync/pull?since=0', { token: a.till.token }),
    );
    const pb = await json<{ restore_epoch: string }>(
      await api('/sync/pull?since=0', { token: b.till.token }),
    );
    expect(pa).toMatchObject({
      restore_epoch: 'new-epoch',
      restore_point_at: 5,
    });
    expect(pb.restore_epoch).not.toBe('new-epoch');
  });

  it('I14 / 23: A over its daily budget gets TENANT_QUOTA and keeps ops; B is applied', async () => {
    const a = await seedShop('Quota A', { budget: 10 });
    const b = await seedShop('Quota B');
    await env.DB.prepare(
      'INSERT INTO tenant_usage (tenant_id, day, rows_written) VALUES (?1, ?2, 10)',
    )
      .bind(a.tenantId, new Date().toISOString().slice(0, 10))
      .run();
    const res = await push(a.till, saleOps(a, a.till, 1));
    expect(res.status).toBe(503);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      'TENANT_QUOTA',
    );
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(
      (await pushOk(b.till, saleOps(b, b.till, 1))).results[0]?.result,
    ).toBe('applied');
    const usage = await env.DB.prepare(
      'SELECT pushes, rows_written FROM tenant_usage WHERE tenant_id = ?1',
    )
      .bind(b.tenantId)
      .first<{ pushes: number; rows_written: number }>();
    expect(usage?.pushes).toBe(1);
    expect(usage?.rows_written).toBeGreaterThan(0);
    // /me doubles the poll interval above 80 %
    const me = await json<{ poll_after_ms: number }>(
      await api('/me', { token: a.till.token }),
    );
    expect(me.poll_after_ms).toBe(120000);
  });

  it('I21 / 24: read-only cutoff, held-back ops stay pending, others unaffected, reactivation applies them', async () => {
    const r = await seedShop('RO R');
    const a = await seedShop('RO A');
    const roStart = Date.now();
    await setStatus(r.tenantId, 'read_only', roStart);
    // A1 was offline: its first push after read-only applies everything.
    const offline = [];
    for (let i = 1; i <= 30; i += 1)
      offline.push(...saleOps(r, r.till, i, { now: roStart - 60_000 }));
    const first = await pushOk(r.till, offline);
    expect(first.results.filter((x) => x.result === 'applied')).toHaveLength(
      60,
    );
    expect(first.tenant_status).toEqual({
      status: 'read_only',
      since: roStart,
    });
    const seen = await env.DB.prepare(
      'SELECT read_only_seen_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(r.tenantId, r.till.id)
      .first<{ read_only_seen_at: number }>();
    expect(seen?.read_only_seen_at).toBeGreaterThan(0);
    const seenAt = seen?.read_only_seen_at ?? 0;
    // A forged push: one old tx (applied) and one 1 hour later (omitted).
    const old = saleOps(r, r.till, 31, { now: seenAt + 60_000 });
    const late = saleOps(r, r.till, 32, { now: seenAt + 3_600_000 });
    const mixed = await pushOk(r.till, [...old, ...late]);
    expect(mixed.results.map((x) => x.op_id)).toEqual(old.map((o) => o.op_id));
    const onlyLate = await push(r.till, late);
    expect(onlyLate.status).toBe(403);
    expect(
      (
        await json<{ error: { code: string; details: { since: number } } }>(
          onlyLate,
        )
      ).error,
    ).toMatchObject({
      code: 'TENANT_READ_ONLY',
      details: { since: roStart },
    });
    // pull, snapshot and /me keep working; other tenants unaffected
    expect(
      (await api('/sync/pull?since=0', { token: r.admin.token })).status,
    ).toBe(200);
    expect((await api('/sync/snapshot', { token: r.admin.token })).status).toBe(
      200,
    );
    const aPush = await pushOk(a.till, saleOps(a, a.till, 1));
    expect(aPush.tenant_status).toEqual({ status: 'active', since: null });
    // reactivation applies the held-back op
    await setStatus(r.tenantId, 'active');
    await env.DB.prepare(
      'UPDATE devices SET read_only_seen_at = NULL WHERE tenant_id = ?1',
    )
      .bind(r.tenantId)
      .run();
    const after = await pushOk(r.till, late);
    expect(after.results.map((x) => x.result)).toEqual(['applied', 'applied']);
  });

  it('I24 / 25: support devices cannot push, can pull and snapshot, stop at expires_at', async () => {
    const a = await seedShop('Sup A');
    const live = await addSupportDevice(a, Date.now() + 3_600_000);
    const res = await push(live, saleOps(a, live, 1));
    expect(res.status).toBe(403);
    expect(
      (await api('/sync/pull?since=0', { token: live.token })).status,
    ).toBe(200);
    expect((await api('/sync/snapshot', { token: live.token })).status).toBe(
      200,
    );
    const expired = await addSupportDevice(a, Date.now() - 1);
    const gone = await api('/sync/pull?since=0', { token: expired.token });
    expect(gone.status).toBe(401);
    expect((await json<{ error: { code: string } }>(gone)).error.code).toBe(
      'DEVICE_REVOKED',
    );
  });
});

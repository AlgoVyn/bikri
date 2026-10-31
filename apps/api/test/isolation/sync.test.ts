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

  it('I25: M3 purchases, returns, refunds and day closes stay inside their tenant', async () => {
    const a = await seedShop('M3 A');
    const b = await seedShop('M3 B');
    const now = Date.now();
    const ids = {
      purchase: newId(now),
      line: newId(now),
      supplierReturn: newId(now),
      returnLine: newId(now),
      dayClose: newId(now),
      sale: newId(now),
      refund: newId(now),
      refundPayment: newId(now),
    };
    const rows = (shop: Awaited<ReturnType<typeof seedShop>>, mark: string) => {
      const purchase = {
        id: ids.purchase,
        supplier_id: IDS.supplier,
        supplier_invoice_no: `SUP-${mark}`,
        other_charges: 0,
        total: 500,
        paid_now: 0,
        paid_method: null,
        line_count: 1,
        note: mark,
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: now,
      };
      const line = {
        id: ids.line,
        purchase_id: ids.purchase,
        line_no: 1,
        product_id: IDS.product,
        qty_milli: 1000,
        unit_cost: 500,
        line_total: 500,
        charges_alloc: 0,
        landed_unit_cost: 500,
        created_at: now,
      };
      const supplierReturn = {
        id: ids.supplierReturn,
        supplier_id: IDS.supplier,
        purchase_id: ids.purchase,
        reason: mark,
        total: 500,
        refund_received: 0,
        refund_method: null,
        line_count: 1,
        note: mark,
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: now,
      };
      const returnLine = {
        id: ids.returnLine,
        return_id: ids.supplierReturn,
        line_no: 1,
        product_id: IDS.product,
        purchase_line_id: ids.line,
        qty_milli: 1000,
        unit_credit: 500,
        line_total: 500,
        cost_snapshot: 0,
        created_at: now,
      };
      const dayClose = {
        id: ids.dayClose,
        device_id: shop.till.id,
        branch_id: shop.branchId,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        period_start: 0,
        period_end: now,
        opening_cash: 0,
        cash_sales: 0,
        udhaar_cash_in: 0,
        pay_ins: 0,
        supplier_cash_in: 0,
        cash_refunds: 0,
        cash_expenses: 0,
        supplier_cash_out: 0,
        pay_outs: 0,
        expected_cash: 0,
        counted_cash: 0,
        difference: 0,
        denominations_json: null,
        note: mark,
        created_at: now,
      };
      const saleLine = newId(now);
      const [saleOp] = saleOps(shop, shop.till, 1);
      if (!saleOp) throw new Error('sale op missing');
      const sale = saleOp.row as Record<string, unknown>;
      const refund = {
        id: ids.refund,
        sale_id: ids.sale,
        kind: 'partial',
        reason: mark,
        method: 'cash',
        exact_amount: 1000,
        udhaar_part: 0,
        rounding: 0,
        amount: 1000,
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: now,
      };
      const refundPayment = {
        id: ids.refundPayment,
        direction: 'out',
        method: 'cash',
        purpose: 'refund',
        amount: 1000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: ids.sale,
        refund_id: ids.refund,
        purchase_id: null,
        supplier_return_id: null,
        party_type: null,
        party_id: null,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: now,
      };
      return [
        op(
          'sales',
          'insert',
          { ...sale, id: ids.sale, note: mark },
          { tx_id: ids.sale },
        ),
        op(
          'sale_lines',
          'insert',
          {
            id: saleLine,
            sale_id: ids.sale,
            line_no: 1,
            product_id: IDS.product,
            name_snapshot: 'Phone',
            sku_snapshot: 'PHN-0001',
            qty_milli: 1000,
            unit_price: 150000,
            gross: 150000,
            discount_type: null,
            discount_value: 0,
            discount: 0,
            net: 150000,
            bill_discount_alloc: 0,
            tax_alloc: 0,
            rounding_alloc: 0,
            unit_cost_snapshot: 0,
            below_cost: 0,
            serial: '',
            warranty_until: null,
            created_at: now,
          },
          { tx_id: ids.sale },
        ),
        op('refunds', 'insert', refund, { tx_id: ids.refund }),
        op('payments', 'insert', refundPayment, { tx_id: ids.refund }),
        op('purchases', 'insert', purchase, { tx_id: ids.purchase }),
        op('purchase_lines', 'insert', line, { tx_id: ids.purchase }),
        op('supplier_returns', 'insert', supplierReturn, {
          tx_id: ids.supplierReturn,
        }),
        op('supplier_return_lines', 'insert', returnLine, {
          tx_id: ids.supplierReturn,
        }),
        op('day_closes', 'insert', dayClose),
        op(
          'refund_lines',
          'insert',
          {
            id: newId(now),
            refund_id: ids.refund,
            sale_line_id: saleLine,
            qty_milli: 1000,
            amount: 1000,
            restock: 1,
            created_at: now,
          },
          { tx_id: ids.refund },
        ),
      ];
    };
    const firstA = rows(a, 'A');
    const firstB = rows(b, 'B');
    const keepIdx = (list: typeof firstA) => [
      ...list.slice(0, 6),
      ...list.slice(8, 10),
    ];
    await pushOk(a.till, keepIdx(firstA));
    await pushOk(b.till, keepIdx(firstB));
    await pushOk(a.till, firstA.slice(6, 8));
    await pushOk(b.till, firstB.slice(6, 8));

    const pa = await pullAll(a.till);
    const pb = await pullAll(b.till);
    const own = (changes: typeof pa, tbl: string, id: string) =>
      changes.find((c) => c.tbl === tbl && c.row.id === id)?.row;
    expect(own(pa, 'purchases', ids.purchase)?.supplier_invoice_no).toBe(
      'SUP-A',
    );
    expect(own(pb, 'purchases', ids.purchase)?.supplier_invoice_no).toBe(
      'SUP-B',
    );
    expect(own(pa, 'supplier_returns', ids.supplierReturn)?.reason).toBe('A');
    expect(own(pb, 'supplier_returns', ids.supplierReturn)?.reason).toBe('B');
    expect(own(pa, 'refunds', ids.refund)?.reason).toBe('A');
    expect(own(pb, 'refunds', ids.refund)?.reason).toBe('B');
    expect(own(pa, 'day_closes', ids.dayClose)?.note).toBe('A');
    expect(own(pb, 'day_closes', ids.dayClose)?.note).toBe('B');
    for (const shop of [a, b]) {
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM purchases WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, ids.purchase)
        .first<{ n: number }>();
      expect(count).toEqual({ n: 1 });
    }
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

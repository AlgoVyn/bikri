import { env } from 'cloudflare:workers';
import { businessDate, newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import {
  addBundleFixture,
  api,
  IDS,
  json,
  seedShop,
} from './helpers/fixtures.ts';
import {
  bundleSaleOps,
  op,
  productRow,
  pullAll,
  push,
  pushOk,
  saleOps,
} from './helpers/ops.ts';

type PushOpLike = ReturnType<typeof op>;
type Err = { error: { code: string } };

const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

describe('push (03 §4.1, §9)', () => {
  it('1: the same push twice → all applied, no duplicates, change_log unchanged', async () => {
    const shop = await seedShop('Idem');
    const ops = saleOps(shop, shop.till, 1);
    const first = await pushOk(shop.till, ops);
    expect(first.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    const logBefore = await count(
      'SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1',
      shop.tenantId,
    );
    const second = await pushOk(shop.till, ops);
    expect(second.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(logBefore);
    const dev = await env.DB.prepare(
      'SELECT last_invoice_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, shop.till.id)
      .first<{ last_invoice_seq: number }>();
    expect(dev?.last_invoice_seq).toBe(1);
  });

  it('1c: two concurrent retries of the same sale write one document and one side-effect set', async () => {
    const shop = await seedShop('Idem race');
    const ops = saleOps(shop, shop.till, 1);
    const [a, b] = await Promise.all([
      pushOk(shop.till, ops),
      pushOk(shop.till, ops),
    ]);
    for (const res of [a, b]) {
      expect(res.results.map((row) => row.error_code ?? null)).toEqual([
        null,
        null,
        null,
      ]);
    }
    for (const [tbl, n] of [
      ['sales', 1],
      ['sale_lines', 1],
      ['payments', 1],
      ['stock_movements', 1],
      ['applied_ops', 3],
    ] as const) {
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM ${tbl} WHERE tenant_id = ?1`,
          shop.tenantId,
        ),
        tbl,
      ).toBe(n);
    }
    expect(
      await env.DB.prepare(
        'SELECT last_invoice_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.till.id)
        .first<{ last_invoice_seq: number }>(),
    ).toEqual({ last_invoice_seq: 1 });
  });

  it('1b: an older client line gets the parent sale business date', async () => {
    const shop = await seedShop('Line date');
    const ops = saleOps(shop, shop.till, 1);
    const sale = ops.find((entry) => entry.tbl === 'sales');
    const line = ops.find((entry) => entry.tbl === 'sale_lines');
    const date = sale?.row?.business_date;
    expect(typeof date).toBe('string');
    expect(line?.row).toBeDefined();
    // Simulate a client built before D-228.
    if (line?.row) delete line.row.business_date;
    await pushOk(shop.till, ops);
    const row = await env.DB.prepare(
      'SELECT business_date FROM sale_lines WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, String(line?.row?.id))
      .first<{ business_date: string }>();
    expect(row?.business_date).toBe(date);
  });

  it('2 + 3: concurrent edits from rev 3 merge field by field with one sync_conflicts row each', async () => {
    const shop = await seedShop('Merge');
    const base = productRow(IDS.product, {
      name_en: 'Merge phone',
      sku: 'PHN-0001',
      price: 150000,
      category_id: IDS.category,
    });
    const a = await pushOk(shop.admin, [
      op(
        'products',
        'upsert',
        { ...base, price: 155000 },
        { base_rev: 3, changed_fields: ['price'] },
      ),
    ]);
    expect(a.results[0]).toMatchObject({ result: 'applied', server_rev: 4 });
    const b = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        { ...base, name_en: 'Renamed' },
        { base_rev: 3, changed_fields: ['name_en'] },
      ),
    ]);
    expect(b.results[0]).toMatchObject({
      result: 'conflict_merged',
      server_rev: 5,
    });
    const row = await env.DB.prepare(
      'SELECT name_en, price, rev FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first();
    expect(row).toEqual({ name_en: 'Renamed', price: 155000, rev: 5 });
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(1);
    const changes = await pullAll(shop.admin);
    // A field merge is a conflict row like any other and must reach existing tills.
    expect(changes.filter((c) => c.tbl === 'sync_conflicts')).toHaveLength(1);
    const last = changes.filter((c) => c.tbl === 'products').at(-1);
    expect(last?.row).toMatchObject({
      name_en: 'Renamed',
      price: 155000,
      rev: 5,
    });
    expect(last?.row).not.toHaveProperty('tenant_id');
  });

  it('4: a delete wins over a concurrent edit', async () => {
    const shop = await seedShop('DeleteWins');
    const del = await pushOk(shop.admin, [
      op(
        'products',
        'delete',
        { id: IDS.product },
        { base_rev: 3, updated_by: IDS.owner },
      ),
    ]);
    expect(del.results[0]?.result).toBe('applied');
    const edit = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          name_en: 'Edited',
          sku: 'PHN-0001',
          deleted_at: null,
        }),
        {
          base_rev: 3,
          changed_fields: ['name_en', 'deleted_at'],
        },
      ),
    ]);
    expect(edit.results[0]?.result).toBe('conflict_merged');
    const row = await env.DB.prepare(
      'SELECT name_en, deleted_at FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ name_en: string; deleted_at: number | null }>();
    expect(row?.name_en).toBe('Edited');
    expect(row?.deleted_at).not.toBeNull();
  });

  it('4b: two transactions editing the same row in one push do not livelock', async () => {
    const shop = await seedShop('SameRowTwice');
    const at = Date.now();
    const base = productRow(IDS.product, {
      name_en: 'Twice phone',
      sku: 'PHN-0001',
      price: 150000,
      category_id: IDS.category,
    });
    const res = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        { ...base, price: 155000 },
        { tx_id: newId(at), base_rev: 3, changed_fields: ['price'] },
      ),
      op(
        'products',
        'delete',
        { id: IDS.product },
        {
          tx_id: newId(at + 1),
          base_rev: 3,
          updated_by: IDS.owner,
        },
      ),
    ]);
    expect(res.results.map((r) => r.result)).toEqual(['applied', 'applied']);
    const row = await env.DB.prepare(
      'SELECT deleted_at, rev FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ deleted_at: number | null; rev: number }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.rev).toBe(5);
  });

  it('5: a sale referencing a customer created in the same batch, in reverse order (deferred FKs)', async () => {
    const shop = await seedShop('Deferred');
    const customerId = newId();
    const now = Date.now();
    const sale = saleOps(shop, shop.till, 1, { customerId });
    const customer = op('customers', 'upsert', {
      id: customerId,
      name: 'Ali',
      phone: '',
      address: '',
      note: '',
      credit_limit: null,
      hard_limit: 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      updated_by: IDS.cashier,
    });
    const res = await pushOk(shop.till, [...sale, customer]);
    expect(res.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('6 + 11: invalid ops are isolated by bisection and the rest are applied', async () => {
    const shop = await seedShop('Bisect');
    const ops = [];
    const bad = new Set([17, 150]);
    for (let i = 0; i < 200; i += 1) {
      const row = productRow(newId(), {
        sku: `B-${i}`,
        price: bad.has(i) ? -5 : 1000 + i,
      });
      ops.push(op('products', 'upsert', row));
    }
    const res = await pushOk(shop.admin, ops);
    expect(res.results).toHaveLength(200);
    const rejected = res.results.flatMap((r, i) =>
      r.result === 'rejected' ? [i] : [],
    );
    expect(rejected).toEqual([17, 150]);
    expect(res.results[17]?.error_code).toBe('CONSTRAINT_FAILED');
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?1 AND sku LIKE 'B-%'",
        shop.tenantId,
      ),
    ).toBe(198);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM applied_ops WHERE tenant_id = ?1 AND result = 'rejected'",
        shop.tenantId,
      ),
    ).toBe(2);
    // a rejected op is answered from applied_ops when sent again
    const again = await pushOk(shop.admin, [ops[17] as (typeof ops)[number]]);
    expect(again.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'CONSTRAINT_FAILED',
    });
  });

  it('7: schema_version below MIN_CLIENT_SCHEMA → 409', async () => {
    const shop = await seedShop('Schema');
    const res = await push(shop.till, saleOps(shop, shop.till, 1), 0);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      'SCHEMA_OUTDATED',
    );
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(0);
  });

  it('12: a lost guarded update is re-applied as a merge', async () => {
    const shop = await seedShop('Race');
    const base = productRow(IDS.product, {
      sku: 'PHN-0001',
      category_id: IDS.category,
    });
    const [x, y] = await Promise.all([
      pushOk(shop.admin, [
        op(
          'products',
          'upsert',
          { ...base, price: 111 },
          { base_rev: 3, changed_fields: ['price'] },
        ),
      ]),
      pushOk(shop.till, [
        op(
          'products',
          'upsert',
          { ...base, notes: 'n' },
          { base_rev: 3, changed_fields: ['notes'] },
        ),
      ]),
    ]);
    const results = [x.results[0]?.result, y.results[0]?.result].sort();
    expect(results).toEqual(['applied', 'conflict_merged']);
    const row = await env.DB.prepare(
      'SELECT rev, price, notes FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first();
    expect(row).toEqual({ rev: 5, price: 111, notes: 'n' });
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(1);
  });

  it('14: an upsert without a newer column keeps that column', async () => {
    const shop = await seedShop('OldClient');
    await env.DB.prepare(
      "UPDATE products SET notes = 'keep me' WHERE tenant_id = ?1 AND id = ?2",
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    const { notes: _n, ...older } = productRow(IDS.product, {
      sku: 'PHN-0001',
      price: 99,
    });
    const res = await pushOk(shop.admin, [
      op('products', 'upsert', older, {
        base_rev: 3,
        changed_fields: ['price'],
      }),
    ]);
    expect(res.results[0]?.result).toBe('applied');
    const row = await env.DB.prepare(
      'SELECT notes, price FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first();
    expect(row).toEqual({ notes: 'keep me', price: 99 });
  });

  it('server checks: other device id, unknown staff, immutable and unknown tables, invoice number, support device', async () => {
    const shop = await seedShop('Checks');
    const [sale] = saleOps(shop, shop.till, 1);
    const foreign = {
      ...(sale?.row ?? {}),
      id: newId(),
      device_id: shop.admin.id,
    };
    const badStaff = {
      ...(sale?.row ?? {}),
      id: newId(),
      staff_id: newId(),
      invoice_no: 'INV-B-2',
      invoice_seq: 2,
    };
    const badInvoice = {
      ...(sale?.row ?? {}),
      id: newId(),
      invoice_no: 'XYZ-B-3',
      invoice_seq: 3,
    };
    const res = await pushOk(shop.till, [
      op('sales', 'insert', foreign),
      op('sales', 'insert', badStaff),
      op('sales', 'insert', badInvoice),
      op('sales', 'upsert', { id: newId() }),
      op('tenants', 'insert', { id: newId() }),
    ]);
    expect(res.results.map((r) => r.error_code)).toEqual([
      'FORBIDDEN',
      'FORBIDDEN',
      'CONSTRAINT_FAILED',
      'IMMUTABLE_TABLE',
      'UNKNOWN_TABLE',
    ]);
    const cashierPrice = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          sku: 'PHN-0001',
          price: 1,
          updated_by: IDS.cashier,
        }),
        {
          base_rev: 3,
          changed_fields: ['price'],
        },
      ),
    ]);
    expect(cashierPrice.results[0]?.error_code).toBe('FORBIDDEN');
    const other = await push(
      shop.till,
      saleOps(shop, shop.till, 9).map((o) => o),
    );
    expect(other.status).toBe(200);
    const wrongDevice = await api('/sync/push', {
      method: 'POST',
      token: shop.till.token,
      json: {
        device_id: shop.admin.id,
        schema_version: 1,
        app_version: '1.1.0',
        ops: saleOps(shop, shop.till, 10),
      },
    });
    expect(wrongDevice.status).toBe(403);
  });

  it('accepts a bill queued with a device code from before a branch move', async () => {
    const shop = await seedShop('Old code');
    await env.DB.prepare(
      'UPDATE devices SET device_code_history = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, shop.till.id, 'Z')
      .run();
    const pushed = await pushOk(
      shop.till,
      saleOps(shop, { ...shop.till, code: 'Z' }, 1),
    );
    expect(pushed.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('rejects a delivery whose line count and total do not reconcile', async () => {
    const shop = await seedShop('Delivery shape');
    const supplierId = newId();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO suppliers (tenant_id, id, name, phone, address, note, created_at, updated_at, updated_by) VALUES (?1, ?2, 'Shape Co', '', '', '', ?3, ?3, ?4)`,
    )
      .bind(shop.tenantId, supplierId, now, IDS.owner)
      .run();
    const purchaseId = newId();
    const res = await pushOk(shop.till, [
      op('purchases', 'insert', {
        id: purchaseId,
        supplier_id: supplierId,
        supplier_invoice_no: '',
        other_charges: 0,
        total: 100000,
        paid_now: 0,
        paid_method: null,
        line_count: 1,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: now,
      }),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM purchases WHERE tenant_id = ?1 AND id = ?2',
        shop.tenantId,
        purchaseId,
      ),
    ).toBe(0);
  });

  it('rejects 201 ops before touching the database', async () => {
    const shop = await seedShop('Boundary 201');
    const ops = Array.from({ length: 201 }, (_, index) =>
      op(
        'products',
        'upsert',
        productRow(newId(), { sku: `MAX-${index}`, price: 1000 }),
      ),
    );
    const res = await push(shop.till, ops);
    expect(res.status).toBe(400);
    expect((await json<Err>(res)).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a push body over 1 MB with 413', async () => {
    const shop = await seedShop('Boundary 1MB');
    const res = await api('/sync/push', {
      method: 'POST',
      token: shop.till.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_id: shop.till.id,
        schema_version: 2,
        app_version: '1.1.0',
        ops: [],
        padding: 'x'.repeat(1_050_000),
      }),
    });
    expect(res.status).toBe(413);
    expect((await json<Err>(res)).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('applies a 200-op push under the CPU budget proxy', async () => {
    const shop = await seedShop('Boundary CPU');
    const ops = Array.from({ length: 200 }, (_, index) =>
      op(
        'products',
        'upsert',
        productRow(newId(), { sku: `CPU-${index}`, price: 1000 + index }),
      ),
    );
    const started = performance.now();
    const res = await push(shop.admin, ops);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed, `200-op push took ${elapsed.toFixed(1)} ms`).toBeLessThan(
      500,
    );
  });
});

function refundPayment(
  shop: Awaited<ReturnType<typeof seedShop>>,
  r: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: newId(),
    direction: 'out',
    method: r.method,
    purpose: 'refund',
    amount: r.amount,
    cash_tendered: null,
    change_given: null,
    reference: '',
    sale_id: r.sale_id,
    refund_id: r.id,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    branch_id: shop.branchId,
    device_id: shop.till.id,
    staff_id: r.staff_id,
    business_date: '2026-10-27',
    created_at: Date.now(),
    ...extra,
  };
}

describe('void rules (05 §5, D-044)', () => {
  it('a manager voids only same-day bills; the owner any day', async () => {
    const shop = await seedShop('Voids');
    const manager = newId();
    await env.DB.prepare(
      `INSERT INTO staff (tenant_id, id, name, role, pin_hash, pin_salt, created_at, updated_at) VALUES (?1, ?2, 'Manager', 'manager', ?3, ?4, ?5, ?5)`,
    )
      .bind(shop.tenantId, manager, 'a'.repeat(44), 'a'.repeat(24), Date.now())
      .run();
    const oldNow = Date.now() - 30 * 86_400_000;
    const oldSale = saleOps(shop, shop.till, 1, { now: oldNow });
    const todaySale = saleOps(shop, shop.till, 2);
    await pushOk(shop.till, [...oldSale, ...todaySale]);
    const sales = [oldSale, todaySale];
    const today = businessDate(Date.now());
    const oldDate = businessDate(oldNow);
    const voidOf = (seq: number, staff: string, date: string) => {
      const saleId = String(sales[seq - 1]?.[0]?.row?.id ?? '');
      const tx = newId();
      return [
        op(
          'sale_voids',
          'insert',
          {
            id: newId(),
            sale_id: saleId,
            reason: 'Wrong item',
            replacement_sale_id: null,
            device_id: shop.till.id,
            staff_id: staff,
            business_date: date,
            created_at: Date.now(),
          },
          { tx_id: tx },
        ),
        op(
          'payments',
          'insert',
          {
            id: newId(),
            direction: 'out',
            method: 'cash',
            purpose: 'void',
            amount: 150000,
            cash_tendered: null,
            change_given: null,
            reference: '',
            sale_id: saleId,
            refund_id: null,
            purchase_id: null,
            supplier_return_id: null,
            party_type: null,
            party_id: null,
            note: '',
            branch_id: shop.branchId,
            device_id: shop.till.id,
            staff_id: staff,
            business_date: date,
            created_at: Date.now(),
          },
          { tx_id: tx },
        ),
      ];
    };
    // The void date is its own event date, not a client-chosen field.
    const future = await pushOk(shop.till, voidOf(1, manager, '2099-01-01'));
    expect(future.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    const copiedOldDate = await pushOk(shop.till, voidOf(1, manager, oldDate));
    expect(copiedOldDate.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    // A manager still cannot void a 30-day-old bill with a valid same-day void date.
    const oldSaleResult = await pushOk(shop.till, voidOf(1, manager, today));
    expect(oldSaleResult.results[0]?.error_code).toBe('FORBIDDEN');
    // The owner may void any day; the void's business date is today.
    const owner = await pushOk(shop.till, voidOf(2, IDS.owner, today));
    expect(owner.results[0]?.error_code ?? null).toBeNull();
  });

  it('a replacement bill needs its sale_voids row; a valid reissue passes', async () => {
    const shop = await seedShop('Reissue link');
    const original = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, original);
    const oldId = String(original[0]?.row?.id ?? '');
    const replacementFor = (seq: number) =>
      saleOps(shop, shop.till, seq, {
        saleId: newId(),
        replacesSaleId: oldId,
        staffId: IDS.owner,
      });
    const missing = replacementFor(2);
    const rejected = await pushOk(shop.till, missing);
    expect(rejected.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1 AND replaces_sale_id = ?2',
        shop.tenantId,
        oldId,
      ),
    ).toBe(0);

    const replacement = replacementFor(3);
    const replacementId = String(replacement[0]?.row?.id ?? '');
    const tx = String(replacement[0]?.tx_id ?? '');
    const today = businessDate(Date.now());
    const now = Date.now();
    const voidRow = op(
      'sale_voids',
      'insert',
      {
        id: newId(),
        sale_id: oldId,
        reason: 'Wrong item',
        replacement_sale_id: replacementId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: today,
        created_at: now,
      },
      { tx_id: tx },
    );
    const voidPayment = op(
      'payments',
      'insert',
      {
        id: newId(),
        direction: 'out',
        method: 'cash',
        purpose: 'void',
        amount: 150000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: oldId,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: null,
        party_id: null,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: today,
        created_at: now,
      },
      { tx_id: tx },
    );
    const applied = await pushOk(shop.till, [
      ...replacement,
      voidRow,
      voidPayment,
    ]);
    expect(applied.results.map((r) => r.error_code ?? null)).toEqual(
      replacement.map(() => null).concat([null, null]),
    );
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1 AND id = ?2 AND replaces_sale_id = ?3',
        shop.tenantId,
        replacementId,
        oldId,
      ),
    ).toBe(1);
  });

  it('T-035 AC: a cashier refund needs an owner override in the same push', async () => {
    const shop = await seedShop('Refunds');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const refund = () => ({
      id: newId(),
      sale_id: sale[0]?.row?.id,
      kind: 'partial',
      reason: 'Faulty',
      method: 'cash',
      exact_amount: 1000,
      udhaar_part: 0,
      rounding: 0,
      amount: 1000,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: '2026-10-27',
      created_at: Date.now(),
    });
    const lineFor = (row: Record<string, unknown>) => ({
      id: newId(),
      refund_id: row.id,
      sale_line_id: sale[1]?.row?.id,
      qty_milli: 1000,
      amount: row.exact_amount,
      restock: 1,
      created_at: Date.now(),
    });
    const aloneRow = refund();
    const alone = await pushOk(shop.till, [
      op('refunds', 'insert', aloneRow),
      op('refund_lines', 'insert', lineFor(aloneRow)),
    ]);
    expect(alone.results[0]?.error_code).toBe('FORBIDDEN');
    const row = refund();
    const tx = newId();
    const approved = await pushOk(shop.till, [
      op('refunds', 'insert', row, { tx_id: tx }),
      op('refund_lines', 'insert', lineFor(row), { tx_id: tx }),
      op('payments', 'insert', refundPayment(shop, row), { tx_id: tx }),
      op(
        'audit_log',
        'insert',
        {
          id: newId(),
          action: 'override',
          entity: 'refunds',
          entity_id: row.id,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'refund.create',
            approved_by: IDS.owner,
          }),
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          created_at: Date.now(),
        },
        { tx_id: tx },
      ),
    ]);
    expect(approved.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('repairs a void return once per product when a sale repeats it on two lines', async () => {
    const shop = await seedShop('Void dedupe');
    const now = Date.now();
    const tx = newId(now);
    const saleId = newId(now);
    const sale = {
      id: saleId,
      invoice_no: `INV-${shop.till.code}-1`,
      invoice_seq: 1,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      customer_id: null,
      business_date: businessDate(now),
      created_at: now,
      line_count: 2,
      items_qty_milli: 2000,
      gross_total: 300000,
      item_discount_total: 0,
      bundle_discount_total: 0,
      subtotal: 300000,
      bill_discount_type: null,
      bill_discount_value: 0,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      tax_inclusive: 0,
      rounding: 0,
      total: 300000,
      paid_total: 300000,
      udhaar_amount: 0,
      cash_tendered: 300000,
      change_given: 0,
      replaces_sale_id: null,
      note: '',
    };
    const line = (lineNo: number) => ({
      id: newId(now),
      sale_id: saleId,
      line_no: lineNo,
      product_id: IDS.product,
      business_date: sale.business_date,
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
    });
    const payment = {
      id: newId(now),
      direction: 'in',
      method: 'cash',
      purpose: 'sale',
      amount: 300000,
      cash_tendered: 300000,
      change_given: 0,
      reference: '',
      sale_id: saleId,
      refund_id: null,
      purchase_id: null,
      supplier_return_id: null,
      party_type: null,
      party_id: null,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: sale.business_date,
      created_at: now,
    };
    await pushOk(shop.till, [
      op('sales', 'insert', sale, { tx_id: tx }),
      op('sale_lines', 'insert', line(1), { tx_id: tx }),
      op('sale_lines', 'insert', line(2), { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
    ]);
    const voidTx = newId(now);
    await pushOk(shop.till, [
      op(
        'sale_voids',
        'insert',
        {
          id: newId(now),
          sale_id: saleId,
          reason: 'Wrong bill',
          replacement_sale_id: null,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: sale.business_date,
          created_at: now,
        },
        { tx_id: voidTx },
      ),
      op(
        'payments',
        'insert',
        {
          ...payment,
          id: newId(now),
          direction: 'out',
          purpose: 'void',
          amount: 300000,
          cash_tendered: null,
          change_given: null,
          staff_id: IDS.owner,
        },
        { tx_id: voidTx },
      ),
    ]);
    const returned = await env.DB.prepare(
      "SELECT COALESCE(SUM(qty_delta_milli), 0) AS qty, COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?1 AND ref_type = 'void' AND product_id = ?2 AND reason_code = 'void_return'",
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ qty: number; n: number }>();
    expect(returned).toEqual({ qty: 2000, n: 1 });
  });

  it('a void arriving after a refund is accepted and flagged for the owner', async () => {
    const shop = await seedShop('Void after refund');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const refund = {
      id: newId(),
      sale_id: sale[0]?.row?.id,
      kind: 'partial',
      reason: 'Faulty',
      method: 'cash',
      exact_amount: 1000,
      udhaar_part: 0,
      rounding: 0,
      amount: 1000,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
    };
    const line = {
      id: newId(),
      refund_id: refund.id,
      sale_line_id: sale[1]?.row?.id,
      qty_milli: 1000,
      amount: 1000,
      restock: 1,
      created_at: Date.now(),
    };
    const refundTx = newId();
    await pushOk(shop.till, [
      op('refunds', 'insert', refund, { tx_id: refundTx }),
      op('refund_lines', 'insert', line, { tx_id: refundTx }),
      op('payments', 'insert', refundPayment(shop, refund), {
        tx_id: refundTx,
      }),
    ]);
    const voidId = newId();
    const voidTx = newId();
    const voidNow = Date.now();
    const res = await pushOk(shop.till, [
      op(
        'sale_voids',
        'insert',
        {
          id: voidId,
          sale_id: sale[0]?.row?.id,
          reason: 'Wrong item',
          replacement_sale_id: null,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(voidNow),
          created_at: voidNow,
        },
        { tx_id: voidTx },
      ),
      op(
        'payments',
        'insert',
        {
          id: newId(),
          direction: 'out',
          method: 'cash',
          purpose: 'void',
          amount: 150000,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: sale[0]?.row?.id,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: null,
          party_type: null,
          party_id: null,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(voidNow),
          created_at: voidNow,
        },
        { tx_id: voidTx },
      ),
    ]);
    expect(res.results[0]?.error_code ?? null).toBeNull();
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1 AND kind = 'refund_after_void' AND row_id = ?2",
        shop.tenantId,
        voidId,
      ),
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT status FROM sales WHERE tenant_id = ?1 AND id = ?2',
        )
          .bind(shop.tenantId, sale[0]?.row?.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe('void');
  });
});

describe('sale policy (07 §6)', () => {
  it('accepts an offline sale whose cost changed after it was rung', async () => {
    const shop = await seedShop('Cost after sale');
    const now = Date.now();
    const ops = saleOps(shop, shop.till, 1);
    await env.DB.prepare(
      'UPDATE products SET avg_cost = 500, last_cost = 500 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    await env.DB.prepare(
      `INSERT INTO stock_movements
       (tenant_id, id, product_id, qty_delta_milli, reason_code, ref_type, ref_id, unit_cost, note, branch_id, device_id, staff_id, business_date, created_at)
       VALUES (?1, ?2, ?3, 1000, 'purchase', 'adjustment', NULL, 500, '', ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        shop.tenantId,
        newId(now + 60_000),
        IDS.product,
        shop.branchId,
        shop.till.id,
        IDS.owner,
        businessDate(now + 60_000),
        now + 60_000,
      )
      .run();
    const res = await pushOk(shop.till, ops);
    expect(res.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('accepts a sale whose cost changed before it while the till was offline', async () => {
    const shop = await seedShop('Cost while offline');
    const now = Date.now();
    const changedAt = now - 120_000;
    const seenAt = now - 240_000;
    await env.DB.prepare(
      'UPDATE products SET avg_cost = 500, last_cost = 500 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, shop.till.id, seenAt)
      .run();
    await env.DB.prepare(
      `INSERT INTO stock_movements
       (tenant_id, id, product_id, qty_delta_milli, reason_code, ref_type, ref_id, unit_cost, note, branch_id, device_id, staff_id, business_date, created_at)
       VALUES (?1, ?2, ?3, 1000, 'purchase', 'adjustment', NULL, 500, '', ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        shop.tenantId,
        newId(changedAt),
        IDS.product,
        shop.branchId,
        shop.till.id,
        IDS.owner,
        businessDate(changedAt),
        changedAt,
      )
      .run();
    const res = await pushOk(shop.till, saleOps(shop, shop.till, 1));
    expect(res.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('does not let a cost-only product upsert smuggle a price into a later sale', async () => {
    const shop = await seedShop('Cost-only price');
    const now = Date.now();
    const tx = newId(now);
    const purchaseId = newId(now);
    const purchase = {
      id: purchaseId,
      supplier_id: IDS.supplier,
      supplier_invoice_no: '',
      other_charges: 0,
      total: 0,
      paid_now: 0,
      paid_method: null,
      line_count: 1,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: businessDate(now),
      created_at: now,
    };
    const line = {
      id: newId(now),
      purchase_id: purchaseId,
      line_no: 1,
      product_id: IDS.product,
      qty_milli: 1000,
      unit_cost: 0,
      line_total: 0,
      charges_alloc: 0,
      landed_unit_cost: 0,
      created_at: now,
    };
    const costOnly = op(
      'products',
      'upsert',
      productRow(IDS.product, {
        sku: 'PHN-0001',
        category_id: IDS.category,
        price: 0,
        last_cost: 0,
        updated_by: IDS.cashier,
      }),
      { tx_id: tx, base_rev: 3, changed_fields: ['last_cost'] },
    );
    const sale = saleOps(shop, shop.till, 1, { total: 0 });
    const res = await pushOk(shop.till, [
      op('purchases', 'insert', purchase, { tx_id: tx }),
      op('purchase_lines', 'insert', line, { tx_id: tx }),
      costOnly,
      ...sale,
    ]);
    expect(
      res.results.find((row) => sale.some((entry) => entry.op_id === row.op_id))
        ?.error_code,
    ).toBe('FORBIDDEN');
    expect(
      await env.DB.prepare(
        'SELECT price FROM products WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, IDS.product)
        .first(),
    ).toEqual({ price: 150000 });
  });

  it('does not use a rejected pending price edit for a later sale', async () => {
    const shop = await seedShop('Rejected price edit');
    const now = Date.now();
    const edit = productRow(IDS.product, {
      price: 200_000,
      updated_at: now,
      updated_by: IDS.cashier,
    });
    const res = await pushOk(shop.till, [
      op('products', 'upsert', edit, {
        base_rev: 3,
        changed_fields: ['price'],
      }),
      ...saleOps(shop, shop.till, 1),
    ]);
    expect(res.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'FORBIDDEN',
    });
    expect(res.results.slice(1).map((row) => row.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('checks a below-list price for a product created in the same push', async () => {
    const shop = await seedShop('New product policy');
    const now = Date.now();
    const productId = newId(now);
    const product = productRow(productId, {
      price: 200_000,
      last_cost: 0,
      created_at: now,
      updated_at: now,
    });
    const ops = saleOps(shop, shop.till, 1);
    for (const entry of ops) {
      if (entry.tbl === 'sale_lines' && entry.row)
        entry.row.product_id = productId;
    }
    const res = await pushOk(shop.till, [
      op('products', 'upsert', product, {
        base_rev: 0,
        changed_fields: [],
      }),
      ...ops,
    ]);
    expect(res.results[0]?.result).toBe('applied');
    expect(res.results.slice(1).map((row) => row.result)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(res.results[1]?.error_code).toBe('FORBIDDEN');
  });
});

describe('bundle discount limit', () => {
  it('measures the whole-bundle discount against the pre-discount bundle price', async () => {
    const shop = await seedShop('Bundle policy');
    await addBundleFixture(shop);
    await env.DB.prepare(
      'UPDATE staff SET max_discount_bp = 10000 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.owner)
      .run();
    const bundle = {
      bundleId: IDS.bundle,
      componentIds: [
        IDS.product,
        IDS.component2,
        IDS.component3,
        IDS.component4,
      ] as [string, string, string, string],
      itemIds: [
        IDS.bundleItem1,
        IDS.bundleItem2,
        IDS.bundleItem3,
        IDS.bundleItem4,
      ] as [string, string, string, string],
    };

    const pushDiscount = (seq: number, staffId: string, discount: number) =>
      pushOk(
        shop.till,
        bundleSaleOps(shop, shop.till, seq, bundle, {
          staffId,
          bundleDiscount: discount,
        }),
      );
    expect(
      (await pushDiscount(1, IDS.owner, 100000)).results[0]?.error_code ?? null,
    ).toBeNull();
    expect(
      (await pushDiscount(2, IDS.owner, 120000)).results[0]?.error_code ?? null,
    ).toBeNull();
    expect(
      (await pushDiscount(3, IDS.cashier, 200000)).results[0],
    ).toMatchObject({
      result: 'rejected',
      error_code: 'FORBIDDEN',
    });
  });
});

describe('bundle recipe guards', () => {
  it('allows a simple component edit alongside a bundle sale', async () => {
    const shop = await seedShop('Bundle edit');
    await addBundleFixture(shop);
    const sale = bundleSaleOps(
      shop,
      shop.till,
      1,
      {
        bundleId: IDS.bundle,
        componentIds: [
          IDS.product,
          IDS.component2,
          IDS.component3,
          IDS.component4,
        ],
        itemIds: [
          IDS.bundleItem1,
          IDS.bundleItem2,
          IDS.bundleItem3,
          IDS.bundleItem4,
        ],
      },
      { staffId: IDS.owner },
    );
    const edit = op(
      'products',
      'upsert',
      productRow(IDS.product, {
        sku: 'PHN-0001',
        category_id: IDS.category,
        price: 150000,
        kind: 'simple',
        name_en: 'Edited component',
      }),
      { base_rev: 3, changed_fields: ['name_en'] },
    );
    const res = await pushOk(shop.till, [...sale, edit]);
    expect(res.results.at(-1)?.error_code ?? null).toBeNull();
    expect(
      await env.DB.prepare(
        'SELECT name_en FROM products WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, IDS.product)
        .first(),
    ).toEqual({ name_en: 'Edited component' });
  });

  it('requires catalog.edit for recipe deletes and keeps at least one item', async () => {
    const shop = await seedShop('Bundle guard');
    const bundleId = newId();
    const itemId = newId();
    const now = Date.now();
    const createTx = newId();
    await pushOk(shop.admin, [
      op(
        'products',
        'upsert',
        productRow(
          bundleId,
          {
            name_en: 'Starter Pack',
            kind: 'bundle',
            track_stock: 0,
            price: 5000,
          },
          now,
        ),
        { tx_id: createTx },
      ),
      op(
        'bundle_items',
        'upsert',
        {
          id: itemId,
          bundle_id: bundleId,
          component_product_id: IDS.product,
          qty_milli: 1000,
          sort_order: 0,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          updated_by: IDS.owner,
        },
        { tx_id: createTx },
      ),
      // The till writes a bundle_change audit in the same transaction; the
      // server's client-action allow-list must accept it or the whole create is
      // rejected FORBIDDEN.
      op(
        'audit_log',
        'insert',
        {
          id: newId(),
          action: 'bundle_change',
          entity: 'products',
          entity_id: bundleId,
          before_json: null,
          after_json: '{"name_en":"Starter Pack"}',
          device_id: shop.admin.id,
          staff_id: IDS.owner,
          created_at: now,
        },
        { tx_id: createTx },
      ),
    ]);
    const denied = await push(shop.till, [
      op(
        'bundle_items',
        'delete',
        { id: itemId },
        { base_rev: 1, updated_by: IDS.cashier },
      ),
    ]);
    const deniedBody = await json<{ results: { error_code?: string }[] }>(
      denied,
    );
    expect(deniedBody.results[0]?.error_code).toBe('FORBIDDEN');
    const last = await push(shop.admin, [
      op(
        'bundle_items',
        'delete',
        { id: itemId },
        { base_rev: 1, updated_by: IDS.owner },
      ),
    ]);
    const lastBody = await json<{ results: { error_code?: string }[] }>(last);
    expect(lastBody.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });
});

describe('pull and snapshot', () => {
  it('caps the D1 rows one shop may read in a UTC day', async () => {
    const shop = await seedShop('Read cap');
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO tenant_usage (tenant_id, day, pushes, rows_written, rows_read) VALUES (?1, ?2, 0, 0, 1000000)',
    )
      .bind(shop.tenantId, day)
      .run();
    const res = await api('/sync/pull?since=0', { token: shop.till.token });
    expect(res.status).toBe(503);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('TENANT_QUOTA');
    const snap = await api('/sync/snapshot', { token: shop.till.token });
    expect(snap.status).toBe(503);
  });

  it('8: pull pages by cursor and ends at the max seq', async () => {
    const shop = await seedShop('Pages');
    const ops = [];
    for (let i = 0; i < 150; i += 1)
      ops.push(
        op('products', 'upsert', productRow(newId(), { sku: `P-${i}` })),
      );
    await pushOk(shop.admin, ops);
    const res = await api('/sync/pull?since=0&limit=60', {
      token: shop.till.token,
    });
    const body = await json<{
      changes: unknown[];
      has_more: boolean;
      next_since: number;
    }>(res);
    expect(body.changes).toHaveLength(60);
    expect(body.has_more).toBe(true);
    const all = await pullAll(shop.till, 0, 60);
    expect(all.filter((c) => c.tbl === 'products')).toHaveLength(150);
    const max = await count(
      'SELECT MAX(seq) AS n FROM change_log WHERE tenant_id = ?1',
      shop.tenantId,
    );
    expect(all.at(-1)?.seq).toBe(max);
  });

  it('advances the cursor past bundle rows hidden from an old client', async () => {
    const shop = await seedShop('Old cursor');
    const start = await count(
      'SELECT MAX(seq) AS n FROM change_log WHERE tenant_id = ?1',
      shop.tenantId,
    );
    const at = Date.now();
    for (const [tbl, row] of [
      ['products', { id: 'bundle-product', kind: 'bundle' }],
      ['bundle_items', { id: 'bundle-item' }],
      ['expenses', { id: 'visible-expense' }],
    ] as const) {
      await env.DB.prepare(
        'INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
        .bind(
          shop.tenantId,
          tbl,
          String(row.id),
          'upsert',
          JSON.stringify(row),
          shop.till.id,
          at,
        )
        .run();
    }
    const first = await api(`/sync/pull?since=${start}&limit=2`, {
      token: shop.till.token,
      headers: { 'x-bikri-schema': '2' },
    });
    const firstBody = await json<{
      changes: unknown[];
      next_since: number;
      has_more: boolean;
    }>(first);
    expect(firstBody.changes).toEqual([]);
    expect(firstBody.has_more).toBe(true);
    expect(firstBody.next_since).toBe(start + 2);
    const second = await api(
      `/sync/pull?since=${firstBody.next_since}&limit=2`,
      {
        token: shop.till.token,
        headers: { 'x-bikri-schema': '2' },
      },
    );
    const secondBody = await json<{
      changes: { tbl: string }[];
    }>(second);
    expect(secondBody.changes.map((change) => change.tbl)).toEqual([
      'expenses',
    ]);
  });

  it('snapshot hides bundle rows from an old client', async () => {
    const shop = await seedShop('Old snapshot');
    const headers = { 'x-bikri-schema': '2' };
    const items = await api('/sync/snapshot?tbl=bundle_items', {
      token: shop.till.token,
      headers,
    });
    expect(items.status).toBe(200);
    expect(await json<{ rows: unknown[] }>(items)).toMatchObject({ rows: [] });
    const products = await json<{ rows: { kind?: string }[] }>(
      await api('/sync/snapshot?tbl=products', {
        token: shop.till.token,
        headers,
      }),
    );
    expect(products.rows.some((row) => row.kind === 'bundle')).toBe(false);
    const start = await json<{ tables: { tbl: string }[] }>(
      await api('/sync/snapshot', { token: shop.till.token, headers }),
    );
    expect(start.tables.map((table) => table.tbl)).not.toContain(
      'bundle_items',
    );
  });

  it('rejects a malformed JSON body without a 500', async () => {
    const shop = await seedShop('Bad JSON');
    const res = await api('/sync/push', {
      method: 'POST',
      token: shop.till.token,
      headers: { 'content-type': 'application/json' },
      body: '{"ops":',
    });
    expect(res.status).toBe(400);
    expect((await json<Err>(res)).error.code).toBe('VALIDATION_FAILED');
  });

  it('snapshot starts without counting every table and pages rows without tenant_id or token_hash', async () => {
    const shop = await seedShop('Snap');
    const start = await json<{
      snapshot_seq: number;
      tables: Array<{ tbl: string; rows: number }>;
    }>(await api('/sync/snapshot', { token: shop.till.token }));
    expect(start.tables[0]?.tbl).toBe('shop');
    // Row totals are not computed at the start: the COUNT(*) pass read every row and
    // was charged to the same budget as the pages, so a large snapshot blocked itself.
    expect(start.tables.find((t) => t.tbl === 'devices')?.rows).toBe(0);
    const devices = await json<{
      rows: Array<Record<string, unknown>>;
      has_more: boolean;
    }>(
      await api('/sync/snapshot?tbl=devices&limit=1', {
        token: shop.till.token,
      }),
    );
    expect(devices.rows).toHaveLength(1);
    expect(devices.has_more).toBe(true);
    expect(devices.rows[0]).not.toHaveProperty('token_hash');
    expect(devices.rows[0]).not.toHaveProperty('tenant_id');
    const bad = await api('/sync/snapshot?tbl=tenants', {
      token: shop.till.token,
    });
    expect(bad.status).toBe(400);
  });
});

describe('refund payment rows and split (04 §5)', () => {
  it('needs one matching payment for the paid part and one ledger row for the udhaar part', async () => {
    const shop = await seedShop('Refund rows');
    const [saleOp, lineOp, paymentOp] = saleOps(shop, shop.till, 1, {
      customerId: IDS.customer,
    });
    const sale: Record<string, unknown> = {
      ...(saleOp?.row as Record<string, unknown>),
      paid_total: 50000,
      udhaar_amount: 100000,
      cash_tendered: 50000,
    };
    const tx = saleOp?.tx_id ?? newId();
    const payment = {
      ...(paymentOp?.row as Record<string, unknown>),
      amount: 50000,
      cash_tendered: 50000,
    };
    const ledger = {
      id: newId(),
      party_type: 'customer',
      party_id: IDS.customer,
      amount: 100000,
      source_type: 'sale',
      source_id: sale.id,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: '2026-10-27',
      created_at: Date.now(),
    };
    await pushOk(shop.till, [
      { ...(saleOp as PushOpLike), row: sale },
      lineOp as PushOpLike,
      { ...(paymentOp as PushOpLike), row: payment },
      op('ledger_entries', 'insert', ledger, { tx_id: tx }),
    ]);
    const base = (over: Record<string, unknown>) => ({
      id: newId(),
      sale_id: sale.id,
      kind: 'partial',
      reason: 'Faulty',
      method: 'cash',
      exact_amount: 1000,
      udhaar_part: 0,
      rounding: 0,
      amount: 1000,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
      ...over,
    });
    const lineFor = (row: Record<string, unknown>) => ({
      id: newId(),
      refund_id: row.id,
      sale_line_id: lineOp?.row?.id,
      qty_milli: 1000,
      amount: row.exact_amount,
      restock: 1,
      created_at: Date.now(),
    });
    const send = async (rows: [string, Record<string, unknown>][]) => {
      const t = newId();
      const expanded = rows.flatMap(([tbl, row]) =>
        tbl === 'refunds'
          ? [
              ['refunds', row] as [string, Record<string, unknown>],
              ['refund_lines', lineFor(row)] as [
                string,
                Record<string, unknown>,
              ],
            ]
          : [[tbl, row] as [string, Record<string, unknown>]],
      );
      const res = await pushOk(
        shop.till,
        expanded.map(([tbl, row]) => op(tbl, 'insert', row, { tx_id: t })),
      );
      return res.results[0]?.error_code ?? null;
    };
    // Paid part without its payment, or with a wrong amount → rejected.
    expect(await send([['refunds', base({})]])).toBe('CONSTRAINT_FAILED');
    const wrong = base({});
    expect(
      await send([
        ['refunds', wrong],
        ['payments', refundPayment(shop, wrong, { amount: 900 })],
      ]),
    ).toBe('CONSTRAINT_FAILED');
    const good = base({});
    expect(
      await send([
        ['refunds', good],
        ['payments', refundPayment(shop, good)],
      ]),
    ).toBeNull();
    // Two refund lines for the same sale line are ambiguous: the old map kept only
    // the last quantity, so a bundle refund could over-refund. Reject the document.
    const duplicate = base({});
    const duplicateTx = newId();
    const firstLine = {
      ...lineFor(duplicate),
      qty_milli: 500,
      amount: 500,
    };
    const secondLine = { ...firstLine, id: newId() };
    const duplicateRes = await pushOk(shop.till, [
      op('refunds', 'insert', duplicate, { tx_id: duplicateTx }),
      op('refund_lines', 'insert', firstLine, { tx_id: duplicateTx }),
      op('refund_lines', 'insert', secondLine, { tx_id: duplicateTx }),
      op(
        'payments',
        'insert',
        refundPayment(shop, duplicate, { amount: 1000 }),
        { tx_id: duplicateTx },
      ),
    ]);
    expect(duplicateRes.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    // Udhaar part: needs exactly one customer ledger row of −udhaar_part.
    const khata = base({
      method: null,
      exact_amount: 30000,
      udhaar_part: 30000,
      amount: 0,
    });
    expect(await send([['refunds', khata]])).toBe('CONSTRAINT_FAILED');
    const entry = {
      id: newId(),
      party_type: 'customer',
      party_id: IDS.customer,
      amount: -30000,
      source_type: 'refund',
      source_id: khata.id,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
    };
    expect(
      await send([
        ['refunds', khata],
        ['ledger_entries', entry],
      ]),
    ).toBeNull();
    // More udhaar than is left on the bill (100,000 − 30,000) → rejected.
    const tooMuch = base({
      method: null,
      exact_amount: 80000,
      udhaar_part: 80000,
      amount: 0,
    });
    expect(
      await send([
        ['refunds', tooMuch],
        [
          'ledger_entries',
          { ...entry, id: newId(), amount: -80000, source_id: tooMuch.id },
        ],
      ]),
    ).toBe('CONSTRAINT_FAILED');
    expect(tx).toBeTruthy();
  });

  it('over-refund from two devices → both accepted + over_refund (10 §3)', async () => {
    const shop = await seedShop('Over refund');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const saleId = sale[0]?.row?.id;
    const lineId = sale[1]?.row?.id;
    const total = Number(sale[0]?.row?.total);
    const full = (device: string) => {
      const t = newId();
      const r = {
        id: newId(),
        sale_id: saleId,
        kind: 'whole',
        reason: 'Faulty',
        method: 'cash',
        exact_amount: total,
        udhaar_part: 0,
        rounding: 0,
        amount: total,
        branch_id: shop.branchId,
        device_id: device,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: Date.now(),
      };
      return [
        op('refunds', 'insert', r, { tx_id: t }),
        op(
          'refund_lines',
          'insert',
          {
            id: newId(),
            refund_id: r.id,
            sale_line_id: lineId,
            qty_milli: 1000,
            amount: total,
            restock: 1,
            created_at: Date.now(),
          },
          { tx_id: t },
        ),
        op(
          'payments',
          'insert',
          refundPayment(shop, r, { device_id: device }),
          {
            tx_id: t,
          },
        ),
      ];
    };
    const a = await pushOk(shop.till, full(shop.till.id));
    const b = await pushOk(shop.admin, full(shop.admin.id));
    expect(
      [...a.results, ...b.results].map((r) => r.error_code ?? null),
    ).toEqual([null, null, null, null, null, null]);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1 AND kind = 'over_refund'",
        shop.tenantId,
      ),
    ).toBe(2);
  });

  it('a sale without a customer cannot take an udhaar part', async () => {
    const shop = await seedShop('No customer');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const r = {
      id: newId(),
      sale_id: sale[0]?.row?.id,
      kind: 'partial',
      reason: 'x',
      method: null,
      exact_amount: 500,
      udhaar_part: 500,
      rounding: 0,
      amount: 0,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
    };
    const res = await pushOk(shop.till, [op('refunds', 'insert', r)]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });
});

describe('supplier return rows (04 §5)', () => {
  it('checks line maths, total, line_count and the refund payment', async () => {
    const shop = await seedShop('Supplier returns');
    const send = async (
      head: Record<string, unknown>,
      lines: Record<string, unknown>[],
      pays: Record<string, unknown>[] = [],
    ) => {
      const t = newId();
      const res = await pushOk(shop.till, [
        op('supplier_returns', 'insert', head, { tx_id: t }),
        ...lines.map((l) =>
          op('supplier_return_lines', 'insert', l, { tx_id: t }),
        ),
        op(
          'ledger_entries',
          'insert',
          {
            id: newId(),
            party_type: 'supplier',
            party_id: head.supplier_id,
            amount: -Number(head.total),
            source_type: 'supplier_return',
            source_id: head.id,
            note: '',
            branch_id: shop.branchId,
            device_id: shop.till.id,
            staff_id: IDS.owner,
            business_date: '2026-10-27',
            created_at: Date.now(),
          },
          { tx_id: t },
        ),
        ...pays.flatMap((p) => [
          op('payments', 'insert', p, { tx_id: t }),
          op(
            'ledger_entries',
            'insert',
            {
              id: newId(),
              party_type: 'supplier',
              party_id: head.supplier_id,
              amount: Number(p.amount),
              source_type: 'payment',
              source_id: p.id,
              note: '',
              branch_id: shop.branchId,
              device_id: shop.till.id,
              staff_id: IDS.owner,
              business_date: '2026-10-27',
              created_at: Date.now(),
            },
            { tx_id: t },
          ),
        ]),
      ]);
      return res.results[0]?.error_code ?? null;
    };
    const head = (over: Record<string, unknown> = {}) => ({
      id: newId(),
      supplier_id: IDS.supplier,
      purchase_id: null,
      reason: 'Damaged',
      total: 3000,
      refund_received: 0,
      refund_method: null,
      line_count: 1,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
      ...over,
    });
    const line = (returnId: unknown, over: Record<string, unknown> = {}) => ({
      id: newId(),
      return_id: returnId,
      line_no: 1,
      product_id: IDS.product,
      purchase_line_id: null,
      qty_milli: 1500,
      unit_credit: 2000,
      line_total: 3000,
      cost_snapshot: 2000,
      created_at: Date.now(),
      ...over,
    });
    const pay = (
      h: Record<string, unknown>,
      over: Record<string, unknown> = {},
    ) => ({
      id: newId(),
      direction: 'in',
      method: h.refund_method,
      purpose: 'supplier_refund',
      amount: h.refund_received,
      cash_tendered: null,
      change_given: null,
      reference: '',
      sale_id: null,
      refund_id: null,
      purchase_id: null,
      supplier_return_id: h.id,
      party_type: 'supplier',
      party_id: IDS.supplier,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: Date.now(),
      ...over,
    });
    let h = head();
    expect(await send(h, [line(h.id, { line_total: 2999 })])).toBe(
      'CONSTRAINT_FAILED',
    );
    h = head({ total: 4000 });
    expect(await send(h, [line(h.id)])).toBe('CONSTRAINT_FAILED');
    h = head({ line_count: 2 });
    expect(await send(h, [line(h.id)])).toBe('CONSTRAINT_FAILED');
    h = head({ refund_received: 1000, refund_method: 'cash' });
    expect(await send(h, [line(h.id)])).toBe('CONSTRAINT_FAILED');
    h = head({ refund_received: 1000, refund_method: 'cash' });
    expect(
      await send(h, [line(h.id)], [pay(h, { method: 'bank_wallet' })]),
    ).toBe('CONSTRAINT_FAILED');
    h = head({ refund_received: 1000, refund_method: 'cash' });
    expect(await send(h, [line(h.id)], [pay(h)])).toBeNull();
    h = head();
    expect(await send(h, [line(h.id)])).toBeNull();
  });

  it('a line linked to another supplier’s delivery is rejected; over-return from two tills is flagged', async () => {
    const shop = await seedShop('Return links');
    const other = newId();
    const purchase = newId();
    const pline = newId();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO suppliers (tenant_id, id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
      ).bind(shop.tenantId, other, 'Other supplier', now),
      env.DB.prepare(
        `INSERT INTO purchases (tenant_id, id, supplier_id, total, line_count, branch_id, device_id, staff_id, business_date, created_at)
         VALUES (?1, ?2, ?3, 4000, 1, ?4, ?5, ?6, '2026-10-26', ?7)`,
      ).bind(
        shop.tenantId,
        purchase,
        IDS.supplier,
        shop.branchId,
        shop.till.id,
        IDS.owner,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO purchase_lines (tenant_id, id, purchase_id, line_no, product_id, qty_milli, unit_cost, line_total, landed_unit_cost, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, 2000, 2000, 4000, 2000, ?5)`,
      ).bind(shop.tenantId, pline, purchase, IDS.product, now),
    ]);
    const ret = (supplier: string, device: string = shop.till.id) => {
      const id = newId();
      const t = newId();
      return [
        op(
          'supplier_returns',
          'insert',
          {
            id,
            supplier_id: supplier,
            purchase_id: null,
            reason: 'Damaged',
            total: 3000,
            refund_received: 0,
            refund_method: null,
            line_count: 1,
            note: '',
            branch_id: shop.branchId,
            device_id: device,
            staff_id: IDS.owner,
            business_date: '2026-10-27',
            created_at: Date.now(),
          },
          { tx_id: t },
        ),
        op(
          'supplier_return_lines',
          'insert',
          {
            id: newId(),
            return_id: id,
            line_no: 1,
            product_id: IDS.product,
            purchase_line_id: pline,
            qty_milli: 1500,
            unit_credit: 2000,
            line_total: 3000,
            cost_snapshot: 2000,
            created_at: Date.now(),
          },
          { tx_id: t },
        ),
        op(
          'ledger_entries',
          'insert',
          {
            id: newId(),
            party_type: 'supplier',
            party_id: supplier,
            amount: -3000,
            source_type: 'supplier_return',
            source_id: id,
            note: '',
            branch_id: shop.branchId,
            device_id: device,
            staff_id: IDS.owner,
            business_date: '2026-10-27',
            created_at: Date.now(),
          },
          { tx_id: t },
        ),
      ];
    };
    const wrong = await pushOk(shop.till, ret(other));
    expect(wrong.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    const a = await pushOk(shop.till, ret(IDS.supplier));
    const b = await pushOk(shop.admin, ret(IDS.supplier, shop.admin.id));
    expect(
      [...a.results, ...b.results].map((r) => r.error_code ?? null),
    ).toEqual([null, null, null, null, null, null]);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1 AND kind = 'over_return'",
        shop.tenantId,
      ),
    ).toBe(1);
  });
});

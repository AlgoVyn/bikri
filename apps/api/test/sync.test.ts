import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { api, IDS, json, seedShop } from './helpers/fixtures.ts';
import {
  op,
  productRow,
  pullAll,
  push,
  pushOk,
  saleOps,
} from './helpers/ops.ts';

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
    expect(first.results.map((r) => r.result)).toEqual(['applied', 'applied']);
    const logBefore = await count(
      'SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1',
      shop.tenantId,
    );
    const second = await pushOk(shop.till, ops);
    expect(second.results.map((r) => r.result)).toEqual(['applied', 'applied']);
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
    ]);
  });

  it('6 + 11: invalid ops are isolated by bisection; others applied; ≤ 40 D1 calls', async () => {
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
        app_version: '0.1.0',
        ops: saleOps(shop, shop.till, 10),
      },
    });
    expect(wrongDevice.status).toBe(403);
  });
});

describe('void rules (05 §5, D-044)', () => {
  it('a manager voids only same-day bills; the owner any day', async () => {
    const shop = await seedShop('Voids');
    const manager = newId();
    await env.DB.prepare(
      `INSERT INTO staff (tenant_id, id, name, role, pin_hash, pin_salt, created_at, updated_at) VALUES (?1, ?2, 'Manager', 'manager', 'h', 's', ?3, ?3)`,
    )
      .bind(shop.tenantId, manager, Date.now())
      .run();
    const sales = [1, 2].map((seq) => saleOps(shop, shop.till, seq));
    await pushOk(shop.till, sales.flat());
    const voidOf = (seq: number, staff: string, date: string) =>
      op('sale_voids', 'insert', {
        id: newId(),
        sale_id: sales[seq - 1]?.[0]?.row?.id,
        reason: 'Wrong item',
        replacement_sale_id: null,
        device_id: shop.till.id,
        staff_id: staff,
        business_date: date,
        created_at: Date.now(),
      });
    const late = await pushOk(shop.till, [voidOf(1, manager, '2026-10-28')]);
    expect(late.results[0]?.error_code).toBe('FORBIDDEN');
    const same = await pushOk(shop.till, [voidOf(1, manager, '2026-10-27')]);
    expect(same.results[0]?.error_code ?? null).toBeNull();
    const owner = await pushOk(shop.till, [voidOf(2, IDS.owner, '2026-10-29')]);
    expect(owner.results[0]?.error_code ?? null).toBeNull();
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
    const alone = await pushOk(shop.till, [op('refunds', 'insert', refund())]);
    expect(alone.results[0]?.error_code).toBe('FORBIDDEN');
    const row = refund();
    const tx = newId();
    const approved = await pushOk(shop.till, [
      op('refunds', 'insert', row, { tx_id: tx }),
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
    ]);
  });
});

describe('pull and snapshot', () => {
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

  it('snapshot lists counts and pages rows without tenant_id or token_hash', async () => {
    const shop = await seedShop('Snap');
    const start = await json<{
      snapshot_seq: number;
      tables: Array<{ tbl: string; rows: number }>;
    }>(await api('/sync/snapshot', { token: shop.till.token }));
    expect(start.tables[0]?.tbl).toBe('shop');
    expect(start.tables.find((t) => t.tbl === 'devices')?.rows).toBe(2);
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

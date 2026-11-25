import { env } from 'cloudflare:workers';
import { businessDate, newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { addBundleFixture, IDS, seedShop } from './helpers/fixtures.ts';
import { op, productRow, pullAll, pushOk, saleOps } from './helpers/ops.ts';

const count = async (sql: string, ...params: unknown[]): Promise<number> =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

const purchaseOps = (shop: Awaited<ReturnType<typeof seedShop>>) => {
  const now = Date.now();
  const tx = newId(now);
  const purchaseId = newId(now);
  return {
    purchaseId,
    now,
    ops: [
      op(
        'purchases',
        'insert',
        {
          id: purchaseId,
          supplier_id: IDS.supplier,
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
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'purchase_lines',
        'insert',
        {
          id: newId(now),
          purchase_id: purchaseId,
          line_no: 1,
          product_id: IDS.product,
          qty_milli: 1000,
          unit_cost: 100000,
          line_total: 100000,
          charges_alloc: 0,
          landed_unit_cost: 100000,
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'stock_movements',
        'insert',
        {
          id: newId(now),
          product_id: IDS.product,
          qty_delta_milli: 1000,
          reason_code: 'purchase',
          ref_type: 'purchase',
          ref_id: purchaseId,
          unit_cost: 100000,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'ledger_entries',
        'insert',
        {
          id: newId(now),
          party_type: 'supplier',
          party_id: IDS.supplier,
          amount: 100000,
          source_type: 'purchase',
          source_id: purchaseId,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          last_cost: 100000,
          updated_by: IDS.owner,
          updated_at: now,
        }),
        { tx_id: tx, base_rev: 3, changed_fields: ['last_cost'] },
      ),
    ],
  };
};

describe('2026-11-25 review remediation', () => {
  it('API-C1: publishes the final avg_cost after a companion product upsert', async () => {
    const shop = await seedShop('C1 final average');
    const delivery = purchaseOps(shop);
    const pushed = await pushOk(shop.till, delivery.ops);
    expect(pushed.results.every((r) => r.result === 'applied')).toBe(true);
    const stored = await env.DB.prepare(
      'SELECT avg_cost, last_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ avg_cost: number; last_cost: number }>();
    expect(stored).toEqual({ avg_cost: 100000, last_cost: 100000 });
    const changes = await pullAll(shop.till);
    const pulled = changes.filter((change) => change.tbl === 'products').at(-1);
    expect(Number(pulled?.row.avg_cost)).toBe(100000);
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, Date.now() + 1_000, shop.till.id)
      .run();
    const sale = saleOps(shop, shop.till, 1).map((entry) => {
      if (entry.tbl === 'sale_lines' && entry.row)
        entry.row.unit_cost_snapshot = 100000;
      return entry;
    });
    const saleRes = await pushOk(shop.till, sale);
    expect(saleRes.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('API-H1: a replayed ledger insert cannot justify a cashier last_cost edit', async () => {
    const shop = await seedShop('H1 forged ledger');
    const now = Date.now();
    const movementId = newId(now);
    await env.DB.prepare(
      `INSERT INTO stock_movements
       (tenant_id, id, product_id, qty_delta_milli, reason_code, ref_type, ref_id, unit_cost, note, branch_id, device_id, staff_id, business_date, created_at)
       VALUES (?1, ?2, ?3, 1000, 'purchase', 'purchase', NULL, 100000, '', ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        shop.tenantId,
        movementId,
        IDS.product,
        shop.branchId,
        shop.till.id,
        IDS.owner,
        businessDate(now),
        now,
      )
      .run();
    const tx = newId(now);
    const res = await pushOk(shop.till, [
      op(
        'stock_movements',
        'insert',
        {
          id: movementId,
          product_id: IDS.product,
          qty_delta_milli: 1000,
          reason_code: 'purchase',
          ref_type: 'purchase',
          ref_id: null,
          unit_cost: 0,
          note: 'forged',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'products',
        'upsert',
        productRow(IDS.product, {
          last_cost: 12345,
          updated_by: IDS.cashier,
          updated_at: now,
        }),
        { tx_id: tx, base_rev: 3, changed_fields: ['last_cost'] },
      ),
    ]);
    expect(res.results.at(-1)?.error_code).toBe('FORBIDDEN');
  });

  it('API-H2: rejects duplicate ledger rows for one payment', async () => {
    const shop = await seedShop('H2 duplicate payment');
    const now = Date.now();
    const tx = newId(now);
    const paymentId = newId(now);
    const ledger = (id: string) =>
      op(
        'ledger_entries',
        'insert',
        {
          id,
          party_type: 'customer',
          party_id: IDS.customer,
          amount: -100000,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      );
    const res = await pushOk(shop.till, [
      op(
        'payments',
        'insert',
        {
          id: paymentId,
          direction: 'in',
          method: 'cash',
          purpose: 'customer_payment',
          amount: 100000,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: null,
          party_type: 'customer',
          party_id: IDS.customer,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      ledger(newId(now)),
      ledger(newId(now)),
    ]);
    expect(res.results.every((r) => r.error_code === 'CONSTRAINT_FAILED')).toBe(
      true,
    );
  });

  it('API-H3: a stored soft delete is not resurrected by a narrowed recipe edit', async () => {
    const shop = await seedShop('H3 soft delete');
    const bundle = await addBundleFixture(shop, 'H3');
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE bundle_items SET deleted_at = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, bundle.itemIds[0], now)
      .run();
    const tx = newId(now);
    const res = await pushOk(shop.till, [
      op(
        'bundle_items',
        'upsert',
        {
          id: bundle.itemIds[0],
          bundle_id: bundle.bundleId,
          component_product_id: bundle.componentIds[0],
          qty_milli: 1000,
          sort_order: 9,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          rev: 0,
          updated_by: IDS.owner,
        },
        { tx_id: tx, base_rev: 0, changed_fields: ['sort_order'] },
      ),
      ...bundle.itemIds
        .slice(1)
        .map((id) =>
          op('bundle_items', 'delete', { id }, { tx_id: tx, base_rev: 0 }),
        ),
    ]);
    expect(res.results.every((r) => r.error_code === 'CONSTRAINT_FAILED')).toBe(
      true,
    );
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM bundle_items WHERE tenant_id = ?1 AND bundle_id = ?2 AND deleted_at IS NULL',
        shop.tenantId,
        bundle.bundleId,
      ),
    ).toBe(3);
  });

  it('API-M3: a replayed sale cannot poison last_invoice_seq', async () => {
    const shop = await seedShop('M3 invoice replay');
    const sale = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sale);
    const seq = async () =>
      (
        await env.DB.prepare(
          'SELECT last_invoice_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
        )
          .bind(shop.tenantId, shop.till.id)
          .first<{ last_invoice_seq: number }>()
      )?.last_invoice_seq;
    expect(await seq()).toBe(1);
    const saleRow = sale.find((entry) => entry.tbl === 'sales')?.row;
    if (!saleRow) throw new Error('sale fixture missing');
    const replay = op(
      'sales',
      'insert',
      { ...saleRow, invoice_seq: Number.MAX_SAFE_INTEGER },
      { tx_id: newId() },
    );
    const res = await pushOk(shop.till, [replay]);
    expect(res.results[0]?.result).toBe('applied');
    expect(await seq()).toBe(1);
  });

  it('API-M5: accepts narrowed promises, branches and bundle_items updates', async () => {
    const shop = await seedShop('M5 narrowed updates');
    const bundle = await addBundleFixture(shop, 'M5');
    const now = Date.now();
    const promiseId = newId(now);
    await env.DB.prepare(
      `INSERT INTO promises (tenant_id, id, customer_id, promised_on, amount, status, note, created_at, updated_at, rev, updated_by)
       VALUES (?1, ?2, ?3, ?4, 1000, 'open', '', ?5, ?5, 1, ?6)`,
    )
      .bind(
        shop.tenantId,
        promiseId,
        IDS.customer,
        businessDate(now),
        now,
        IDS.owner,
      )
      .run();
    const branch = await env.DB.prepare(
      'SELECT id, rev FROM branches WHERE tenant_id = ?1',
    )
      .bind(shop.tenantId)
      .first<{ id: string; rev: number }>();
    if (!branch) throw new Error('branch missing');
    const promise = await pushOk(shop.till, [
      op(
        'promises',
        'upsert',
        {
          id: promiseId,
          status: 'kept',
          updated_at: now,
          updated_by: IDS.owner,
        },
        { tx_id: newId(now), base_rev: 1, changed_fields: ['status'] },
      ),
    ]);
    expect(promise.results[0]?.error_code ?? null).toBeNull();
    const branchUpdate = await pushOk(shop.till, [
      op(
        'branches',
        'upsert',
        {
          id: branch.id,
          name: 'Renamed branch',
          updated_at: now,
          updated_by: IDS.owner,
        },
        { tx_id: newId(now), base_rev: branch.rev, changed_fields: ['name'] },
      ),
    ]);
    expect(branchUpdate.results[0]?.error_code ?? null).toBeNull();
    const itemUpdate = await pushOk(shop.till, [
      op(
        'bundle_items',
        'upsert',
        {
          id: bundle.itemIds[0],
          qty_milli: 2000,
          updated_at: now,
          updated_by: IDS.owner,
        },
        { tx_id: newId(now), base_rev: 0, changed_fields: ['qty_milli'] },
      ),
    ]);
    expect(itemUpdate.results[0]?.error_code ?? null).toBeNull();
  });
});

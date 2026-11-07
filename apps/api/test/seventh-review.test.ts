import { env } from 'cloudflare:workers';
import { businessDate, newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, pushOk, saleOps } from './helpers/ops.ts';

const DAY = 86_400_000;
const codes = (res: {
  results: Array<{ op_id: string; error_code?: string }>;
}) => res.results.map((row) => row.error_code ?? null);

const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

function payment(
  shop: Awaited<ReturnType<typeof seedShop>>,
  overrides: Record<string, unknown>,
) {
  const now = Date.now();
  return {
    id: newId(now),
    direction: 'out',
    method: 'cash',
    purpose: 'refund',
    amount: 150000,
    cash_tendered: null,
    change_given: null,
    reference: '',
    sale_id: null,
    refund_id: null,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    branch_id: shop.branchId,
    device_id: shop.till.id,
    staff_id: IDS.owner,
    business_date: businessDate(now),
    created_at: now,
    ...overrides,
  };
}

describe('seventh review sync fixes', () => {
  it('applies a refund with restock for a sale in an earlier transaction of the same push', async () => {
    const shop = await seedShop('Same push refund');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    const saleLineId = String(sale[1]?.row?.id);
    const now = Date.now();
    const refundId = newId(now);
    const tx = newId(now);
    const res = await pushOk(shop.till, [
      ...sale,
      op(
        'refunds',
        'insert',
        {
          id: refundId,
          sale_id: saleId,
          kind: 'whole',
          reason: 'return',
          method: 'cash',
          exact_amount: 150000,
          udhaar_part: 0,
          rounding: 0,
          amount: 150000,
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'refund_lines',
        'insert',
        {
          id: newId(now),
          refund_id: refundId,
          sale_line_id: saleLineId,
          qty_milli: 1000,
          amount: 150000,
          restock: 1,
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'payments',
        'insert',
        payment(shop, {
          purpose: 'refund',
          refund_id: refundId,
          sale_id: saleId,
        }),
        { tx_id: tx },
      ),
      op(
        'stock_movements',
        'insert',
        {
          id: newId(now),
          product_id: IDS.product,
          qty_delta_milli: 1000,
          reason_code: 'refund_return',
          ref_type: 'refund',
          ref_id: refundId,
          unit_cost: null,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(codes(res)).toEqual([null, null, null, null, null, null, null]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM refunds WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(1);
  });

  it('applies a void with return movement for a sale in an earlier transaction', async () => {
    const shop = await seedShop('Same push void');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    const now = Date.now();
    const voidId = newId(now);
    const tx = newId(now);
    const res = await pushOk(shop.till, [
      ...sale,
      op(
        'sale_voids',
        'insert',
        {
          id: voidId,
          sale_id: saleId,
          reason: 'mistake',
          replacement_sale_id: null,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'payments',
        'insert',
        payment(shop, { purpose: 'void', sale_id: saleId }),
        { tx_id: tx },
      ),
      op(
        'stock_movements',
        'insert',
        {
          id: newId(now),
          product_id: IDS.product,
          qty_delta_milli: 1000,
          reason_code: 'void_return',
          ref_type: 'void',
          ref_id: voidId,
          unit_cost: null,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(codes(res)).toEqual([null, null, null, null, null, null]);
  });

  it('lets a cashier created in an earlier transaction ring a sale in the same push', async () => {
    const shop = await seedShop('Same push staff');
    const now = Date.now();
    const staffId = newId(now);
    const staff = {
      id: staffId,
      name: 'New cashier',
      role: 'cashier',
      active: 1,
      permissions_json: '{}',
      max_discount_bp: 500,
      pin_hash: 'h',
      pin_salt: 's',
      created_at: now,
      updated_at: now,
      deleted_at: null,
      updated_by: IDS.owner,
    };
    const sale = saleOps(shop, shop.till, 2);
    for (const row of sale) {
      if (row.row && 'staff_id' in row.row) row.row.staff_id = staffId;
    }
    const res = await pushOk(shop.till, [
      op('staff', 'upsert', staff, { base_rev: 0, changed_fields: [] }),
      ...sale,
    ]);
    expect(codes(res)).toEqual([null, null, null, null]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1 AND staff_id = ?2',
        shop.tenantId,
        staffId,
      ),
    ).toBe(1);
  });

  it('rejects a future updated_at on a catalogue row', async () => {
    const shop = await seedShop('Future clock');
    const now = Date.now();
    const row = {
      id: IDS.product,
      name_en: 'Future',
      category_id: IDS.category,
      sku: 'PHN-0001',
      price: 150000,
      last_cost: 0,
      track_stock: 1,
      created_at: now,
      updated_at: now + 2 * DAY,
      deleted_at: null,
      updated_by: IDS.owner,
    };
    const res = await pushOk(shop.admin, [
      op('products', 'upsert', row, {
        base_rev: 3,
        changed_fields: ['price'],
      }),
    ]);
    expect(codes(res)).toEqual(['CONSTRAINT_FAILED']);
  });

  it('rejects a cashier approving their own over-limit discount', async () => {
    const shop = await seedShop('Self approve');
    const now = Date.now();
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    sale[0]!.row = {
      ...sale[0]!.row,
      subtotal: 150000,
      bill_discount_type: 'pct',
      bill_discount_value: 1000,
      bill_discount: 15000,
      total: 135000,
      paid_total: 135000,
      cash_tendered: 135000,
      change_given: 0,
    };
    sale[1]!.row = {
      ...sale[1]!.row,
      bill_discount_alloc: 15000,
    };
    sale[2]!.row = {
      ...sale[2]!.row,
      amount: 135000,
      cash_tendered: 135000,
      change_given: 0,
    };
    const tx = String(sale[0]?.tx_id);
    const res = await pushOk(shop.till, [
      ...sale,
      op(
        'audit_log',
        'insert',
        {
          id: newId(now),
          action: 'override',
          entity: 'sales',
          entity_id: saleId,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'sale.discount',
            approved_by: IDS.cashier,
          }),
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(codes(res)).toContain('FORBIDDEN');
  });

  it('enforces append-only ledger rows at the database level', async () => {
    const shop = await seedShop('Append only');
    await pushOk(shop.till, saleOps(shop, shop.till, 1));
    const saleId = (
      await env.DB.prepare('SELECT id FROM sales WHERE tenant_id = ?1 LIMIT 1')
        .bind(shop.tenantId)
        .first<{ id: string }>()
    )?.id;
    expect(saleId).toBeTruthy();
    await expect(
      env.DB.prepare(
        "UPDATE sales SET note = 'rewritten' WHERE tenant_id = ?1 AND id = ?2",
      )
        .bind(shop.tenantId, saleId)
        .run(),
    ).rejects.toThrow(/append-only/u);
    await expect(
      env.DB.prepare('DELETE FROM sales WHERE tenant_id = ?1 AND id = ?2')
        .bind(shop.tenantId, saleId)
        .run(),
    ).rejects.toThrow(/append-only/u);
    await env.DB.prepare(
      "UPDATE tenants SET status = 'maintenance' WHERE id = ?1",
    )
      .bind(shop.tenantId)
      .run();
    for (const table of ['sale_lines', 'payments', 'stock_movements'])
      await env.DB.prepare(`DELETE FROM ${table} WHERE tenant_id = ?1`)
        .bind(shop.tenantId)
        .run();
    await env.DB.prepare('DELETE FROM sales WHERE tenant_id = ?1 AND id = ?2')
      .bind(shop.tenantId, saleId)
      .run();
  });

  it('rejects a payment-sourced ledger row on a sale payment', async () => {
    const shop = await seedShop('Payment ledger');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    const paymentId = String(sale[2]?.row?.id);
    const now = Date.now();
    const tx = String(sale[0]?.tx_id);
    const res = await pushOk(shop.till, [
      ...sale,
      op(
        'ledger_entries',
        'insert',
        {
          id: newId(now),
          party_type: 'customer',
          party_id: IDS.customer,
          amount: -150000,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          business_date: businessDate(now),
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(codes(res)).toContain('CONSTRAINT_FAILED');
    expect(saleId.length).toBeGreaterThan(0);
  });
});

import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, pushOk, saleOps } from './helpers/ops.ts';

const now = Date.now();

describe('client/server sync contract regressions', () => {
  it('accepts a customer created with an opening balance', async () => {
    const shop = await seedShop('Opening balance');
    const tx = newId(now);
    const customerId = newId(now);
    const customer = {
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
      updated_by: IDS.owner,
    };
    const ledger = {
      id: newId(now),
      party_type: 'customer',
      party_id: customerId,
      amount: 500000,
      source_type: 'opening',
      source_id: null,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      op('customers', 'upsert', customer, { tx_id: tx }),
      op('ledger_entries', 'insert', ledger, { tx_id: tx }),
    ]);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([null, null]);
  });

  it('accepts a supplier return with cash received and its ledger row', async () => {
    const shop = await seedShop('Supplier refund');
    const tx = newId(now);
    const returnId = newId(now);
    const paymentId = newId(now);
    const head = {
      id: returnId,
      supplier_id: IDS.supplier,
      purchase_id: null,
      reason: 'Damaged',
      total: 3000,
      refund_received: 1000,
      refund_method: 'cash',
      line_count: 1,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    const line = {
      id: newId(now),
      return_id: returnId,
      line_no: 1,
      product_id: IDS.product,
      purchase_line_id: null,
      qty_milli: 1500,
      unit_credit: 2000,
      line_total: 3000,
      cost_snapshot: 2000,
      created_at: now,
    };
    const payment = {
      id: paymentId,
      direction: 'in',
      method: 'cash',
      purpose: 'supplier_refund',
      amount: 1000,
      cash_tendered: null,
      change_given: null,
      reference: '',
      sale_id: null,
      refund_id: null,
      purchase_id: null,
      supplier_return_id: returnId,
      party_type: 'supplier',
      party_id: IDS.supplier,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    const ledger = {
      id: newId(now),
      party_type: 'supplier',
      party_id: IDS.supplier,
      amount: 1000,
      source_type: 'payment',
      source_id: paymentId,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      op('supplier_returns', 'insert', head, { tx_id: tx }),
      op('supplier_return_lines', 'insert', line, { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
      op('ledger_entries', 'insert', ledger, { tx_id: tx }),
    ]);
    expect(res.results.every((r) => r.error_code === undefined)).toBe(true);
  });

  it('accepts an override void when the audit is keyed by the void id', async () => {
    const shop = await seedShop('Void override');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    await pushOk(shop.till, sale);
    const tx = newId(now);
    const voidId = newId(now);
    const res = await pushOk(shop.till, [
      op(
        'sale_voids',
        'insert',
        {
          id: voidId,
          sale_id: saleId,
          reason: 'Wrong item',
          replacement_sale_id: null,
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'payments',
        'insert',
        {
          id: newId(now),
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
          staff_id: IDS.cashier,
          business_date: '2026-10-27',
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
          reason_code: 'void_return',
          ref_type: 'void',
          ref_id: voidId,
          unit_cost: null,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      ),
      op(
        'audit_log',
        'insert',
        {
          id: newId(now),
          action: 'override',
          entity: 'sale_voids',
          entity_id: voidId,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'sale.void',
            approved_by: IDS.owner,
          }),
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(res.results.every((r) => r.error_code === undefined)).toBe(true);
    const status = await env.DB.prepare(
      'SELECT status FROM sales WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, saleId)
      .first<{ status: string }>();
    expect(status?.status).toBe('void');
  });

  it('does not recompute avg_cost when the same stock movement is replayed', async () => {
    const shop = await seedShop('Replay movement');
    const movement = {
      id: newId(now),
      product_id: IDS.product,
      qty_delta_milli: 10000,
      reason_code: 'opening',
      ref_type: 'opening',
      ref_id: null,
      unit_cost: 10000,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    await pushOk(shop.till, [op('stock_movements', 'insert', movement)]);
    const first = await env.DB.prepare(
      'SELECT avg_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ avg_cost: number }>();
    expect(first?.avg_cost).toBe(10000);
    // Replay with a fresh op id, as restore recovery does.
    const replayed = await pushOk(shop.till, [
      op('stock_movements', 'insert', movement),
    ]);
    expect(replayed.results[0]?.error_code ?? null).toBeNull();
    const second = await env.DB.prepare(
      'SELECT avg_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ avg_cost: number }>();
    expect(second?.avg_cost).toBe(10000);
  });
});

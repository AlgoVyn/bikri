import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import {
  op,
  type PushResponse,
  productRow,
  pushOk,
  saleOps,
} from './helpers/ops.ts';

const codeOf = (res: PushResponse, index: number) =>
  res.results[index]?.error_code ?? null;

describe('query and calculation audit regressions', () => {
  it('sees a ledger row from an earlier transaction when deleting a party', async () => {
    const shop = await seedShop('Ledger order');
    const now = Date.now();
    const base = saleOps(shop, shop.till, 1, { customerId: IDS.customer });
    const sale: Record<string, unknown> = {
      ...(base[0]?.row as Record<string, unknown>),
      paid_total: 100000,
      udhaar_amount: 50000,
      cash_tendered: 100000,
    };
    const payment = {
      ...(base[2]?.row as Record<string, unknown>),
      amount: 100000,
      cash_tendered: 100000,
    };
    const ledger = {
      id: newId(now),
      party_type: 'customer',
      party_id: IDS.customer,
      amount: 50000,
      source_type: 'sale',
      source_id: String(sale.id),
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: String(sale.business_date),
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      { ...base[0]!, row: sale },
      base[1]!,
      { ...base[2]!, row: payment },
      op('ledger_entries', 'insert', ledger, { tx_id: base[0]?.tx_id }),
      op(
        'customers',
        'delete',
        { id: IDS.customer, updated_by: IDS.owner },
        { tx_id: newId(now), updated_by: IDS.owner },
      ),
    ]);
    // The sale's udhaar must make the later delete fail, even though the balance row
    // was read before the sale transaction ran.
    console.log(
      'LEDGER DELETE',
      res.results.map((r) => r.error_code ?? r.result),
    );
    expect(codeOf(res, 4)).toBe('CONSTRAINT_FAILED');
  });

  it('lets a manager edit a customer without changing an existing hard limit', async () => {
    const shop = await seedShop('Manager hard limit');
    const now = Date.now();
    const managerId = newId(now);
    await env.DB.prepare(
      "INSERT INTO staff (tenant_id, id, name, role, pin_hash, pin_salt, created_at, updated_at) VALUES (?1, ?2, 'Manager', 'manager', ?3, ?4, ?5, ?5)",
    )
      .bind(shop.tenantId, managerId, 'a'.repeat(44), 'a'.repeat(24), now)
      .run();
    await env.DB.prepare(
      'UPDATE customers SET hard_limit = 1 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.customer)
      .run();

    const current = await env.DB.prepare(
      'SELECT rev, created_at, credit_limit FROM customers WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.customer)
      .first<{
        rev: number;
        created_at: number;
        credit_limit: number | null;
      }>();
    const res = await pushOk(shop.till, [
      op(
        'customers',
        'upsert',
        {
          id: IDS.customer,
          name: 'Updated customer',
          phone: '03001234567',
          address: '',
          note: '',
          credit_limit: current?.credit_limit ?? null,
          hard_limit: 1,
          created_at: current?.created_at ?? now,
          updated_at: now,
          updated_by: managerId,
        },
        {
          base_rev: current?.rev ?? 1,
          changed_fields: ['phone'],
          updated_by: managerId,
        },
      ),
    ]);
    expect(codeOf(res, 0)).toBeNull();
  });

  it('initialises a new product avg cost from its catalogue cost', async () => {
    const shop = await seedShop('Catalogue cost');
    const now = Date.now();
    const productId = newId(now);
    const product = productRow(
      productId,
      { price: 10000, last_cost: 5000 },
      now,
    );
    const sale = saleOps(shop, shop.till, 1, { total: 10000, now });
    const saleRow = {
      ...(sale[0]?.row as Record<string, unknown>),
      paid_total: 10000,
      udhaar_amount: 0,
    };
    const lineRow = {
      ...(sale[1]?.row as Record<string, unknown>),
      product_id: productId,
      name_snapshot: 'Catalogue product',
      qty_milli: 1000,
      unit_price: 10000,
      gross: 10000,
      net: 10000,
      unit_cost_snapshot: 5000,
      below_cost: 0,
    };
    const paymentRow = {
      ...(sale[2]?.row as Record<string, unknown>),
      amount: 10000,
    };
    const saleTx = newId(now);
    const res = await pushOk(shop.till, [
      op('products', 'upsert', product, {
        tx_id: newId(now),
        base_rev: 0,
        changed_fields: [],
      }),
      { ...sale[0]!, row: saleRow, tx_id: saleTx },
      { ...sale[1]!, row: lineRow, tx_id: saleTx },
      { ...sale[2]!, row: paymentRow, tx_id: saleTx },
    ]);
    console.log(
      'COST',
      res.results.map((r) => [r.result, r.error_code]),
    );
    expect(codeOf(res, 0)).toBeNull();
    expect(codeOf(res, 1)).toBeNull();
    const saved = await env.DB.prepare(
      'SELECT avg_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, productId)
      .first<{ avg_cost: number }>();
    expect(saved?.avg_cost).toBe(5000);
  });
});

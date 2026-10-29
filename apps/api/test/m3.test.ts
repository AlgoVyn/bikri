import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, json, seedShop } from './helpers/fixtures.ts';
import {
  op,
  type PushResponse,
  productRow,
  pushOk,
  saleOps,
} from './helpers/ops.ts';

const now = Date.now();
const codes = (res: PushResponse) =>
  res.results.map((row) => row.error_code ?? null);

async function product(shop: Awaited<ReturnType<typeof seedShop>>, id: string) {
  return env.DB.prepare(
    'SELECT avg_cost, last_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
  )
    .bind(shop.tenantId, id)
    .first<{ avg_cost: number; last_cost: number }>();
}

function movement(
  shop: Awaited<ReturnType<typeof seedShop>>,
  productId: string,
  reason: 'opening' | 'purchase',
  qty: number,
  unitCost: number,
  refId: string | null = null,
) {
  return {
    id: newId(now),
    product_id: productId,
    qty_delta_milli: qty,
    reason_code: reason,
    ref_type: reason === 'opening' ? 'opening' : 'purchase',
    ref_id: refId,
    unit_cost: unitCost,
    note: '',
    branch_id: shop.branchId,
    device_id: shop.till.id,
    staff_id: IDS.owner,
    business_date: '2026-10-27',
    created_at: now,
  };
}

function purchase(
  shop: Awaited<ReturnType<typeof seedShop>>,
  productId: string,
  qty: number,
  unitCost: number,
  staffId: string = IDS.owner,
) {
  const purchaseId = newId(now);
  const lineId = newId(now);
  const lineTotal = Math.round((qty * unitCost) / 1000);
  return {
    id: purchaseId,
    rows: [
      {
        id: purchaseId,
        supplier_id: IDS.supplier,
        supplier_invoice_no: 'SUP-1',
        other_charges: 0,
        total: lineTotal,
        paid_now: 0,
        paid_method: null,
        line_count: 1,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: staffId,
        business_date: '2026-10-27',
        created_at: now,
      },
    ],
    line: {
      id: lineId,
      purchase_id: purchaseId,
      line_no: 1,
      product_id: productId,
      qty_milli: qty,
      unit_cost: unitCost,
      line_total: lineTotal,
      charges_alloc: 0,
      landed_unit_cost: unitCost,
      created_at: now,
    },
  };
}

function refund(
  shop: Awaited<ReturnType<typeof seedShop>>,
  saleId: string,
  udhaar: number,
  saleLineId: string,
  reason = 'Faulty',
) {
  const id = newId(now);
  return {
    row: {
      id,
      sale_id: saleId,
      kind: 'partial',
      reason,
      method: null,
      exact_amount: udhaar,
      udhaar_part: udhaar,
      rounding: 0,
      amount: 0,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    },
    line: {
      id: newId(now),
      refund_id: id,
      sale_line_id: saleLineId,
      qty_milli: 1000,
      amount: udhaar,
      restock: 1,
      created_at: now,
    },
    ledger: {
      id: newId(now),
      party_type: 'customer',
      party_id: IDS.customer,
      amount: -udhaar,
      source_type: 'refund',
      source_id: id,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    },
  };
}

describe('M3 server rules', () => {
  it('computes avg_cost for a product and opening stock in one push (07 §7)', async () => {
    const shop = await seedShop('Avg');
    const id = newId(now);
    const opening = await pushOk(shop.till, [
      op('products', 'upsert', productRow(id, { sku: 'AVG-1' })),
      op(
        'stock_movements',
        'insert',
        movement(shop, id, 'opening', 2000, 10000),
      ),
    ]);
    expect(codes(opening)).toEqual([null, null]);
    expect(await product(shop, id)).toEqual({
      avg_cost: 10000,
      last_cost: 10000,
    });

    const buy = purchase(shop, id, 1000, 20000);
    const buyTx = newId(now);
    const received = await pushOk(shop.till, [
      op('purchases', 'insert', buy.rows[0] as Record<string, unknown>, {
        tx_id: buyTx,
      }),
      op('purchase_lines', 'insert', buy.line, { tx_id: buyTx }),
      op(
        'stock_movements',
        'insert',
        movement(shop, id, 'purchase', 1000, 20000, buy.id),
        { tx_id: buyTx },
      ),
    ]);
    expect(codes(received)).toEqual([null, null, null]);
    expect(await product(shop, id)).toEqual({
      avg_cost: 13333,
      last_cost: 20000,
    });
  });

  it('enforces purchase, cash move and supplier payment permissions (05 §6)', async () => {
    const shop = await seedShop('Perms');
    const buy = purchase(shop, IDS.product, 1000, 5000, IDS.cashier);
    const denied = await pushOk(shop.till, [
      op('purchases', 'insert', buy.rows[0] as Record<string, unknown>, {
        tx_id: newId(now),
      }),
      op(
        'cash_moves',
        'insert',
        {
          id: newId(now),
          kind: 'pay_out',
          amount: 1000,
          reason: 'Tea',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: newId(now) },
      ),
    ]);
    expect(codes(denied)).toEqual(['FORBIDDEN', 'FORBIDDEN']);

    const payment = await pushOk(shop.till, [
      op('payments', 'insert', {
        id: newId(now),
        direction: 'out',
        method: 'cash',
        purpose: 'supplier_payment',
        amount: 1000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: null,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: 'supplier',
        party_id: IDS.supplier,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.cashier,
        business_date: '2026-10-27',
        created_at: now,
      }),
    ]);
    expect(codes(payment)).toEqual(['FORBIDDEN']);
  });

  it('checks cumulative udhaar refunds across one push and ignores forged sale rows', async () => {
    const shop = await seedShop('Refund');
    const sale = saleOps(shop, shop.till, 1, { customerId: IDS.customer });
    sale[0]!.row = {
      ...sale[0]!.row,
      paid_total: 70000,
      udhaar_amount: 80000,
    };
    const pushedSale = await pushOk(shop.till, sale);
    expect(codes(pushedSale)).toEqual([null, null]);
    const saleId = String(sale[0]!.row?.id);
    expect(
      await env.DB.prepare(
        'SELECT paid_total, udhaar_amount FROM sales WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, saleId)
        .first(),
    ).toEqual({ paid_total: 70000, udhaar_amount: 80000 });

    const first = refund(shop, saleId, 50000, String(sale[1]?.row?.id));
    const second = refund(shop, saleId, 50000, String(sale[1]?.row?.id));
    const many = await pushOk(shop.till, [
      op('refunds', 'insert', first.row, { tx_id: first.row.id }),
      op('refund_lines', 'insert', first.line, { tx_id: first.row.id }),
      op('ledger_entries', 'insert', first.ledger, {
        tx_id: first.row.id,
      }),
      op('refunds', 'insert', second.row, { tx_id: second.row.id }),
      op('refund_lines', 'insert', second.line, { tx_id: second.row.id }),
      op('ledger_entries', 'insert', second.ledger, {
        tx_id: second.row.id,
      }),
    ]);
    expect(many.results[0]?.error_code ?? null).toBeNull();
    expect(
      many.results
        .slice(3)
        .every((row) => row.error_code === 'CONSTRAINT_FAILED'),
    ).toBe(true);

    const forged = refund(
      shop,
      saleId,
      50000,
      String(sale[1]?.row?.id),
      'Forged',
    );
    const forgedSale = {
      ...sale[0]!.row,
      id: saleId,
      paid_total: 0,
      udhaar_amount: 150000,
    };
    const forgedRefund = op('refunds', 'insert', forged.row, {
      tx_id: forged.row.id,
    });
    const rejected = await pushOk(shop.till, [
      op('sales', 'insert', forgedSale),
      forgedRefund,
      op('ledger_entries', 'insert', forged.ledger, {
        tx_id: forged.row.id,
      }),
    ]);
    expect(
      rejected.results.find((row) => row.op_id === forgedRefund.op_id)
        ?.error_code,
    ).toBe('CONSTRAINT_FAILED');
  });

  it('validates a refund against a sale created in the same push', async () => {
    const shop = await seedShop('Sale refund');
    const sale = saleOps(shop, shop.till, 1, { customerId: IDS.customer });
    sale[0]!.row = {
      ...sale[0]!.row,
      paid_total: 100000,
      udhaar_amount: 50000,
    };
    const saleId = String(sale[0]!.row?.id);
    const row = refund(shop, saleId, 20000, String(sale[1]?.row?.id));
    const res = await pushOk(shop.till, [
      ...sale,
      op('refunds', 'insert', row.row, { tx_id: row.row.id }),
      op('refund_lines', 'insert', row.line, { tx_id: row.row.id }),
      op('ledger_entries', 'insert', row.ledger, { tx_id: row.row.id }),
    ]);
    expect(codes(res)).toEqual([null, null, null, null, null]);
  });

  it('treats a second void of the same sale as an idempotent no-op', async () => {
    const shop = await seedShop('Void');
    const sale = saleOps(shop, shop.till, 1);
    const pushedSale = await pushOk(shop.till, sale);
    expect(codes(pushedSale)).toEqual([null, null]);
    const saleId = String(sale[0]!.row?.id);
    const voidRow = (id: string) => ({
      id,
      sale_id: saleId,
      reason: 'Changed mind',
      replacement_sale_id: null,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    });
    const first = await pushOk(shop.till, [
      op('sale_voids', 'insert', voidRow(newId(now))),
    ]);
    expect(codes(first)).toEqual([null]);
    const second = await pushOk(shop.till, [
      op('sale_voids', 'insert', voidRow(newId(now))),
    ]);
    expect(codes(second)).toEqual([null]);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sale_voids WHERE tenant_id = ?1 AND sale_id = ?2',
    )
      .bind(shop.tenantId, saleId)
      .first<{ n: number }>();
    expect(count).toEqual({ n: 1 });
  });

  it('validates expense reversals and allows a cashier to reverse a manager expense', async () => {
    const shop = await seedShop('Expense');
    const categoryId = 'electricity';
    await env.DB.prepare(
      "INSERT OR IGNORE INTO expense_categories (tenant_id, id, code, name_en, created_at, updated_at) VALUES (?1, ?2, 'electricity', 'Electricity', ?3, ?3)",
    )
      .bind(shop.tenantId, categoryId, now)
      .run();
    const expenseId = newId(now);
    const base = {
      id: expenseId,
      category_id: categoryId,
      amount: 300000,
      method: 'cash',
      payee: 'K-Electric',
      note: '',
      reverses_id: null,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    await pushOk(shop.till, [op('expenses', 'insert', base)]);

    const reversal = {
      ...base,
      id: newId(now),
      reverses_id: expenseId,
      staff_id: IDS.cashier,
      created_at: now + 1,
    };
    const reversed = await pushOk(shop.till, [
      op('expenses', 'insert', reversal),
    ]);
    expect(codes(reversed)).toEqual([null]);

    const duplicate = await pushOk(shop.till, [
      op('expenses', 'insert', { ...reversal, id: newId(now) }),
    ]);
    expect(codes(duplicate)).toEqual(['CONSTRAINT_FAILED']);

    // A cashier cannot approve another cashier's over-limit expense.
    const approvedByCashier = await pushOk(shop.till, [
      op('expenses', 'insert', {
        ...base,
        id: newId(now),
        amount: 300000,
        staff_id: IDS.cashier,
      }),
      op('audit_log', 'insert', {
        id: newId(now),
        action: 'override',
        entity: 'expenses',
        entity_id: expenseId,
        before_json: null,
        after_json: JSON.stringify({
          permission: 'expense.create',
          approved_by: IDS.cashier,
        }),
        device_id: shop.till.id,
        staff_id: IDS.cashier,
        created_at: now,
      }),
    ]);
    expect(approvedByCashier.results[0]?.error_code).toBe('FORBIDDEN');
  });
});

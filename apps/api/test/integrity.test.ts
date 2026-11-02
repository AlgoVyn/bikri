import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, type PushResponse, pushOk, saleOps } from './helpers/ops.ts';

const now = Date.now();
const codes = (res: PushResponse) =>
  res.results.map((row) => row.error_code ?? null);

async function udhaarSale(shop: Awaited<ReturnType<typeof seedShop>>) {
  const sale = saleOps(shop, shop.till, 1, { customerId: IDS.customer });
  const saleOp = sale[0]!;
  const lineOp = sale[1]!;
  const paymentOp = sale[2]!;
  const saleRow: Record<string, unknown> = {
    ...(saleOp.row ?? {}),
    paid_total: 100000,
    udhaar_amount: 50000,
    cash_tendered: 100000,
  };
  const payment = {
    ...(paymentOp.row as Record<string, unknown>),
    amount: 100000,
    cash_tendered: 100000,
  };
  const ledger = {
    id: newId(now),
    party_type: 'customer',
    party_id: IDS.customer,
    amount: 50000,
    source_type: 'sale',
    source_id: saleRow.id,
    note: '',
    branch_id: shop.branchId,
    device_id: shop.till.id,
    staff_id: IDS.cashier,
    business_date: '2026-10-27',
    created_at: now,
  };
  const res = await pushOk(shop.till, [
    { ...saleOp, row: saleRow },
    lineOp,
    { ...paymentOp, row: payment },
    op('ledger_entries', 'insert', ledger, { tx_id: saleOp.tx_id }),
  ]);
  expect(codes(res)).toEqual([null, null, null, null]);
  return { saleId: String(saleRow.id), paid: 100000, udhaar: 50000 };
}

function voidRows(
  shop: Awaited<ReturnType<typeof seedShop>>,
  saleId: string,
  ledger: Record<string, unknown> | null,
) {
  const tx = newId(now);
  const voidId = newId(now);
  return {
    tx,
    voidId,
    ops: [
      op(
        'sale_voids',
        'insert',
        {
          id: voidId,
          sale_id: saleId,
          reason: 'Wrong item',
          replacement_sale_id: null,
          device_id: shop.till.id,
          staff_id: IDS.owner,
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
          amount: 100000,
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
          staff_id: IDS.owner,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      ),
      ...(ledger
        ? [op('ledger_entries', 'insert', ledger, { tx_id: tx })]
        : []),
    ],
  };
}

function ledgerRow(
  shop: Awaited<ReturnType<typeof seedShop>>,
  over: Record<string, unknown>,
) {
  return {
    id: newId(now),
    note: '',
    branch_id: shop.branchId,
    device_id: shop.till.id,
    staff_id: IDS.owner,
    business_date: '2026-10-27',
    created_at: now,
    ...over,
  };
}

describe('document integrity checks (03 §4.1, 07 §5)', () => {
  it('rejects void ledger rows with the wrong amount or party', async () => {
    const shop = await seedShop('Void ledger');
    const sale = await udhaarSale(shop);
    const wrongAmount = voidRows(
      shop,
      sale.saleId,
      ledgerRow(shop, {
        party_type: 'customer',
        party_id: IDS.customer,
        amount: -40000,
        source_type: 'void',
        source_id: null,
      }),
    );
    // The void row id is not known until the helper builds it.
    const wrong = wrongAmount.ops[2]?.row as Record<string, unknown>;
    wrong.source_id = wrongAmount.voidId;
    expect(codes(await pushOk(shop.till, wrongAmount.ops))).toContain(
      'CONSTRAINT_FAILED',
    );

    const wrongParty = voidRows(
      shop,
      sale.saleId,
      ledgerRow(shop, {
        party_type: 'supplier',
        party_id: IDS.supplier,
        amount: -sale.udhaar,
        source_type: 'void',
        source_id: null,
      }),
    );
    const partyRow = wrongParty.ops[2]?.row as Record<string, unknown>;
    partyRow.source_id = wrongParty.voidId;
    expect(codes(await pushOk(shop.till, wrongParty.ops))).toContain(
      'CONSTRAINT_FAILED',
    );

    const good = voidRows(
      shop,
      sale.saleId,
      ledgerRow(shop, {
        party_type: 'customer',
        party_id: IDS.customer,
        amount: -sale.udhaar,
        source_type: 'void',
        source_id: null,
      }),
    );
    const goodRow = good.ops[2]?.row as Record<string, unknown>;
    goodRow.source_id = good.voidId;
    expect(codes(await pushOk(shop.till, good.ops))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('rejects a refund line that belongs to another sale', async () => {
    const shop = await seedShop('Refund line sale');
    const first = saleOps(shop, shop.till, 1);
    const second = saleOps(shop, shop.till, 2);
    await pushOk(shop.till, first);
    await pushOk(shop.till, second);
    const firstSale = String(first[0]?.row?.id);
    const secondLine = String(second[1]?.row?.id);
    const refundId = newId(now);
    const tx = newId(now);
    const refund = {
      id: refundId,
      sale_id: firstSale,
      kind: 'partial',
      reason: 'Wrong item',
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
    const line = {
      id: newId(now),
      refund_id: refundId,
      sale_line_id: secondLine,
      qty_milli: 1000,
      amount: 1000,
      restock: 0,
      created_at: now,
    };
    const payment = {
      id: newId(now),
      direction: 'out',
      method: 'cash',
      purpose: 'refund',
      amount: 1000,
      cash_tendered: null,
      change_given: null,
      reference: '',
      sale_id: null,
      refund_id: refundId,
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
    const res = await pushOk(shop.till, [
      op('refunds', 'insert', refund, { tx_id: tx }),
      op('refund_lines', 'insert', line, { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
    ]);
    expect(codes(res)).toEqual([
      'CONSTRAINT_FAILED',
      'CONSTRAINT_FAILED',
      'CONSTRAINT_FAILED',
    ]);
  });

  it('rejects purchase and supplier-return ledger rows for another supplier', async () => {
    const shop = await seedShop('Purchase ledger');
    const purchaseId = newId(now);
    const lineId = newId(now);
    const purchase = {
      id: purchaseId,
      supplier_id: IDS.supplier,
      supplier_invoice_no: 'SUP-1',
      other_charges: 0,
      total: 5000,
      paid_now: 0,
      paid_method: null,
      line_count: 1,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
    };
    const line = {
      id: lineId,
      purchase_id: purchaseId,
      line_no: 1,
      product_id: IDS.product,
      qty_milli: 1000,
      unit_cost: 5000,
      line_total: 5000,
      charges_alloc: 0,
      landed_unit_cost: 5000,
      created_at: now,
    };
    const tx = newId(now);
    const wrong = await pushOk(shop.till, [
      op('purchases', 'insert', purchase, { tx_id: tx }),
      op('purchase_lines', 'insert', line, { tx_id: tx }),
      op(
        'ledger_entries',
        'insert',
        ledgerRow(shop, {
          party_type: 'supplier',
          party_id: '01JB0000000000000000000099',
          amount: 5000,
          source_type: 'purchase',
          source_id: purchaseId,
        }),
        { tx_id: tx },
      ),
    ]);
    expect(codes(wrong)).toContain('CONSTRAINT_FAILED');

    const returnId = newId(now);
    const returnLineId = newId(now);
    const ret = {
      id: returnId,
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
      created_at: now,
    };
    const returnLine = {
      id: returnLineId,
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
    const tx2 = newId(now);
    const wrongReturn = await pushOk(shop.till, [
      op('supplier_returns', 'insert', ret, { tx_id: tx2 }),
      op('supplier_return_lines', 'insert', returnLine, { tx_id: tx2 }),
      op(
        'ledger_entries',
        'insert',
        ledgerRow(shop, {
          party_type: 'supplier',
          party_id: '01JB0000000000000000000099',
          amount: -3000,
          source_type: 'supplier_return',
          source_id: returnId,
        }),
        { tx_id: tx2 },
      ),
    ]);
    expect(codes(wrongReturn)).toContain('CONSTRAINT_FAILED');
  });

  it('rejects payment rows without their source document', async () => {
    const shop = await seedShop('Payment source');
    const tx = newId(now);
    const payment = (over: Record<string, unknown>) => ({
      id: newId(now),
      direction: 'in',
      method: 'cash',
      amount: 1000,
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
      staff_id: IDS.cashier,
      business_date: '2026-10-27',
      created_at: now,
      ...over,
    });
    expect(
      codes(
        await pushOk(shop.till, [
          op(
            'payments',
            'insert',
            payment({ purpose: 'sale', sale_id: newId(now) }),
            { tx_id: tx },
          ),
        ]),
      ),
    ).toContain('CONSTRAINT_FAILED');
    expect(
      codes(
        await pushOk(shop.till, [
          op(
            'payments',
            'insert',
            payment({
              purpose: 'customer_payment',
              party_type: 'customer',
              party_id: IDS.customer,
            }),
            { tx_id: newId(now) },
          ),
        ]),
      ),
    ).toContain('CONSTRAINT_FAILED');
  });

  it('lets an owner create a cashier and use them in the same action', async () => {
    const shop = await seedShop('Group staff');
    const staffId = newId(now);
    const staff = {
      id: staffId,
      name: 'New cashier',
      role: 'cashier',
      pin_hash: 'h',
      pin_salt: 's',
      pin_iterations: 150000,
      pin_length: 4,
      permissions_json: '{}',
      color: 'c1',
      must_change_pin: 0,
      active: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      updated_by: IDS.owner,
    };
    const tx = newId(now);
    const sale = saleOps(shop, shop.till, 1).map((row) =>
      row.tbl === 'sales' || row.tbl === 'payments'
        ? { ...row, tx_id: tx, row: { ...row.row, staff_id: staffId } }
        : { ...row, tx_id: tx },
    );
    const res = await pushOk(shop.till, [
      op('staff', 'upsert', staff, { tx_id: tx }),
      ...sale,
    ]);
    expect(codes(res)).toEqual([null, null, null, null]);

    const denied = await pushOk(shop.till, [
      op(
        'staff',
        'upsert',
        { ...staff, id: newId(now), name: 'Sneaky', updated_by: IDS.cashier },
        { tx_id: newId(now) },
      ),
    ]);
    expect(codes(denied)).toEqual(['FORBIDDEN']);
  });

  it('accepts a new party and its opening balance with the new cashier in one action', async () => {
    const shop = await seedShop('Opening staff');
    const staffId = newId(now);
    const customerId = newId(now);
    const tx = newId(now);
    const staff = {
      id: staffId,
      name: 'Opening cashier',
      role: 'cashier',
      pin_hash: 'h',
      pin_salt: 's',
      pin_iterations: 150000,
      pin_length: 4,
      permissions_json: '{}',
      color: 'c1',
      must_change_pin: 0,
      active: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      updated_by: IDS.owner,
    };
    const customer = {
      id: customerId,
      name: 'New khata',
      phone: '',
      address: '',
      note: '',
      credit_limit: null,
      hard_limit: 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      updated_by: staffId,
    };
    const ledger = {
      id: newId(now),
      party_type: 'customer',
      party_id: customerId,
      amount: 250000,
      source_type: 'opening',
      source_id: null,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: staffId,
      business_date: '2026-10-27',
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      op('staff', 'upsert', staff, { tx_id: tx }),
      op('customers', 'upsert', customer, { tx_id: tx, base_rev: 0 }),
      op('ledger_entries', 'insert', ledger, { tx_id: tx }),
    ]);
    expect(codes(res)).toEqual([null, null, null]);
  });

  it('rejects child rows without their parent in the same push', async () => {
    const shop = await seedShop('Orphan child');
    for (const [tbl, parent] of [
      ['sale_lines', 'sale_id'],
      ['refund_lines', 'refund_id'],
      ['purchase_lines', 'purchase_id'],
      ['supplier_return_lines', 'return_id'],
    ] as const) {
      const res = await pushOk(shop.till, [
        op(tbl, 'insert', { id: newId(now), [parent]: newId(now) }),
      ]);
      expect(codes(res), tbl).toEqual(['CONSTRAINT_FAILED']);
    }
  });

  it('requires dayclose.create and a sane period', async () => {
    const shop = await seedShop('Day close');
    await env.DB.prepare(
      'UPDATE staff SET permissions_json = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.cashier, '{"dayclose.create":false}')
      .run();
    const close = (staffId: string, over: Record<string, unknown> = {}) => ({
      id: newId(now),
      device_id: shop.till.id,
      branch_id: shop.branchId,
      staff_id: staffId,
      business_date: '2026-10-27',
      period_start: now - 1000,
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
      note: '',
      created_at: now,
      ...over,
    });
    expect(
      codes(
        await pushOk(shop.till, [
          op('day_closes', 'insert', close(IDS.cashier)),
        ]),
      ),
    ).toEqual(['FORBIDDEN']);
    expect(
      codes(
        await pushOk(shop.till, [
          op('day_closes', 'insert', close(IDS.owner, { period_end: now + 1 })),
        ]),
      ),
    ).toEqual(['CONSTRAINT_FAILED']);
    expect(
      codes(
        await pushOk(shop.till, [op('day_closes', 'insert', close(IDS.owner))]),
      ),
    ).toEqual([null]);
  });

  it('rejects stock movements with the wrong sign or a missing cost', async () => {
    const shop = await seedShop('Stock signs');
    const movement = (over: Record<string, unknown>) => ({
      id: newId(now),
      product_id: IDS.product,
      qty_delta_milli: 1000,
      reason_code: 'sale',
      ref_type: 'sale',
      ref_id: null,
      unit_cost: null,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      created_at: now,
      ...over,
    });
    expect(
      codes(
        await pushOk(shop.till, [
          op('stock_movements', 'insert', movement({ qty_delta_milli: 1000 })),
        ]),
      ),
    ).toEqual(['CONSTRAINT_FAILED']);
    expect(
      codes(
        await pushOk(shop.till, [
          op(
            'stock_movements',
            'insert',
            movement({ reason_code: 'opening', qty_delta_milli: -1000 }),
          ),
        ]),
      ),
    ).toEqual(['CONSTRAINT_FAILED']);
    expect(
      codes(
        await pushOk(shop.till, [
          op(
            'stock_movements',
            'insert',
            movement({ reason_code: 'purchase', ref_type: 'purchase' }),
          ),
        ]),
      ),
    ).toEqual(['CONSTRAINT_FAILED']);
  });
});

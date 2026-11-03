import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { api, IDS, json, seedShop } from './helpers/fixtures.ts';
import { op, productRow, pushOk, saleOps } from './helpers/ops.ts';

const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

describe('review fixes', () => {
  it('soft-deletes a row created and deleted in the same push', async () => {
    const shop = await seedShop('Create delete');
    const id = newId();
    const res = await pushOk(shop.admin, [
      op('products', 'upsert', productRow(id, { sku: 'CD-1' }), {
        base_rev: 0,
        changed_fields: [],
      }),
      op('products', 'delete', { id }, { base_rev: 0, updated_by: IDS.owner }),
    ]);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([null, null]);
    expect(
      await env.DB.prepare(
        'SELECT deleted_at FROM products WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, id)
        .first<{ deleted_at: number | null }>(),
    ).toMatchObject({ deleted_at: expect.any(Number) });
  });

  it('adds the missing stock movement for a sale instead of leaving stock short', async () => {
    const shop = await seedShop('Sale stock repair');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    const res = await pushOk(shop.till, sale);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
    const movement = await env.DB.prepare(
      "SELECT product_id, qty_delta_milli, ref_type, ref_id FROM stock_movements WHERE tenant_id = ?1 AND ref_id = ?2 AND reason_code = 'sale'",
    )
      .bind(shop.tenantId, saleId)
      .first<{
        product_id: string;
        qty_delta_milli: number;
        ref_type: string;
        ref_id: string;
      }>();
    expect(movement).toEqual({
      product_id: IDS.product,
      qty_delta_milli: -1000,
      ref_type: 'sale',
      ref_id: saleId,
    });
  });

  it('rejects duplicate row ids instead of summing and storing one', async () => {
    const shop = await seedShop('Duplicate rows');
    const base = saleOps(shop, shop.till, 1, { total: 300000 });
    const sale = { ...(base[0]?.row ?? {}) };
    const line = { ...(base[1]?.row ?? {}) };
    const payment = { ...(base[2]?.row ?? {}) };
    Object.assign(sale, {
      gross_total: 300000,
      subtotal: 300000,
      total: 300000,
      paid_total: 300000,
      cash_tendered: 300000,
      change_given: 0,
    });
    Object.assign(line, {
      unit_price: 300000,
      gross: 300000,
      net: 300000,
    });
    const tx = String((sale as Record<string, unknown>).id);
    const res = await pushOk(shop.till, [
      op('sales', 'insert', sale, { tx_id: tx }),
      op('sale_lines', 'insert', line, { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
      op('payments', 'insert', { ...payment, amount: 150000 }, { tx_id: tx }),
    ]);
    expect(res.results.every((r) => r.result === 'rejected')).toBe(true);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1 AND id = ?2',
        shop.tenantId,
        sale.id,
      ),
    ).toBe(0);
  });

  it('rejects a customer delete while the ledger has a balance', async () => {
    const shop = await seedShop('Delete balance');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO ledger_entries (tenant_id, id, party_type, party_id, amount, source_type, source_id, branch_id, device_id, staff_id, business_date, created_at)
       VALUES (?1, ?2, 'customer', ?3, 1000, 'adjustment', NULL, ?4, ?5, ?6, '2026-10-27', ?7)`,
    )
      .bind(
        shop.tenantId,
        newId(now),
        IDS.customer,
        shop.branchId,
        shop.till.id,
        IDS.owner,
        now,
      )
      .run();
    const res = await pushOk(shop.admin, [
      op(
        'customers',
        'delete',
        { id: IDS.customer },
        { updated_by: IDS.owner },
      ),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    expect(
      await env.DB.prepare(
        'SELECT deleted_at FROM customers WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, IDS.customer)
        .first<{ deleted_at: number | null }>(),
    ).toMatchObject({ deleted_at: null });
  });

  it('accepts an offline sale from a staff member deactivated afterwards', async () => {
    const shop = await seedShop('Deactivated staff');
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE staff SET active = 0, updated_at = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.cashier, now)
      .run();
    const res = await pushOk(
      shop.till,
      saleOps(shop, shop.till, 1, { now: now - 1000 }),
    );
    expect(res.results.every((r) => r.error_code === undefined)).toBe(true);
  });

  it('rejects a cashier-created hard credit limit', async () => {
    const shop = await seedShop('Cashier limit');
    const now = Date.now();
    const customer = {
      id: newId(now),
      name: 'Limited',
      phone: '',
      address: '',
      note: '',
      credit_limit: null,
      hard_limit: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      updated_by: IDS.cashier,
    };
    const res = await pushOk(shop.till, [
      op('customers', 'upsert', customer, { base_rev: 0, changed_fields: [] }),
    ]);
    expect(res.results[0]?.error_code).toBe('FORBIDDEN');
  });

  it('rejects a sale whose tax does not match its snapshot rate', async () => {
    const shop = await seedShop('Sale tax');
    const base = saleOps(shop, shop.till, 1, { total: 100000 });
    const sale = {
      ...(base[0]?.row ?? {}),
      tax_rate_bp: 1700,
      tax: 0,
      tax_inclusive: 0,
    };
    const tx = String((sale as Record<string, unknown>).id);
    const res = await pushOk(shop.till, [
      op('sales', 'insert', sale, { tx_id: tx }),
      op('sale_lines', 'insert', base[1]?.row ?? {}, { tx_id: tx }),
      op('payments', 'insert', base[2]?.row ?? {}, { tx_id: tx }),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('requires a bound approval for a below-list price override', async () => {
    const shop = await seedShop('Price override');
    const base = saleOps(shop, shop.till, 1);
    const line = base[1]?.row ?? {};
    const sale = {
      ...(base[0]?.row ?? {}),
      gross_total: 40000,
      subtotal: 40000,
      total: 40000,
      paid_total: 40000,
      cash_tendered: 40000,
    };
    const lineRow = {
      ...line,
      unit_price: 40000,
      gross: 40000,
      net: 40000,
    };
    const payment = {
      ...(base[2]?.row ?? {}),
      amount: 40000,
      cash_tendered: 40000,
    };
    const saleRow = sale as Record<string, unknown>;
    const lineId = String((lineRow as Record<string, unknown>).id);
    const tx = String(saleRow.id);
    const denied = await pushOk(shop.till, [
      op('sales', 'insert', sale, { tx_id: tx }),
      op('sale_lines', 'insert', lineRow, { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
    ]);
    expect(denied.results[0]?.error_code).toBe('FORBIDDEN');
    const approved = await pushOk(shop.till, [
      op('sales', 'insert', sale, { tx_id: tx }),
      op('sale_lines', 'insert', lineRow, { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
      op(
        'audit_log',
        'insert',
        {
          id: newId(),
          action: 'override',
          entity: 'sales',
          entity_id: saleRow.id,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'catalog.edit',
            approved_by: IDS.owner,
            bound_line: lineId,
            bound_price: 40000,
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

  it('reconstructs bill-discount allocations in cart order, not line_no order', async () => {
    const shop = await seedShop('Allocation order');
    const now = Date.now() - 60_000;
    const tx = newId(now);
    const saleId = newId(now);
    const baseLine = {
      sale_id: saleId,
      product_id: null,
      name_snapshot: 'Item',
      sku_snapshot: '',
      qty_milli: 1000,
      unit_price: 2,
      gross: 2,
      discount_type: null,
      discount_value: 0,
      discount: 0,
      net: 2,
      tax_alloc: 0,
      rounding_alloc: 0,
      unit_cost_snapshot: 0,
      below_cost: 0,
      serial: '',
      warranty_until: null,
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      op(
        'sales',
        'insert',
        {
          id: saleId,
          invoice_no: `INV-${shop.till.code}-9`,
          invoice_seq: 9,
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          customer_id: null,
          business_date: '2026-10-27',
          created_at: now,
          line_count: 2,
          items_qty_milli: 2000,
          gross_total: 4,
          item_discount_total: 0,
          subtotal: 4,
          bill_discount_type: 'rs',
          bill_discount_value: 1,
          bill_discount: 1,
          tax_rate_bp: 0,
          tax: 0,
          tax_inclusive: 0,
          rounding: 0,
          total: 3,
          paid_total: 3,
          udhaar_amount: 0,
          cash_tendered: 3,
          change_given: 0,
          replaces_sale_id: null,
          note: '',
        },
        { tx_id: tx },
      ),
      op(
        'sale_lines',
        'insert',
        { ...baseLine, id: newId(now), line_no: 1, bill_discount_alloc: 0 },
        { tx_id: tx },
      ),
      op(
        'sale_lines',
        'insert',
        { ...baseLine, id: newId(now), line_no: 2, bill_discount_alloc: 1 },
        { tx_id: tx },
      ),
      op(
        'payments',
        'insert',
        {
          id: newId(now),
          direction: 'in',
          method: 'cash',
          purpose: 'sale',
          amount: 3,
          cash_tendered: 3,
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
          staff_id: IDS.owner,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('does not apply a later costed movement with the phantom average of a rejected group', async () => {
    const shop = await seedShop('Phantom avg');
    const now = Date.now();
    const movement = (tx: string, cost: number, branchId: string) =>
      op(
        'stock_movements',
        'insert',
        {
          id: newId(now),
          product_id: IDS.product,
          qty_delta_milli: 1000,
          reason_code: 'received_local',
          ref_type: 'adjustment',
          ref_id: null,
          unit_cost: cost,
          note: '',
          branch_id: branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      );
    const res = await pushOk(shop.till, [
      // This group passes planning but fails the branch FK in D1.
      movement(newId(now), 10000, '01JB00000000000000000000XX'),
      movement(newId(now), 20000, shop.branchId),
    ]);
    expect(res.results[0]?.result).toBe('rejected');
    expect(res.results[1]?.result).toBe('applied');
    const product = await env.DB.prepare(
      'SELECT avg_cost, last_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ avg_cost: number; last_cost: number }>();
    // On hand was zero when the valid movement applied; the rejected one never counted.
    expect(product).toEqual({ avg_cost: 20000, last_cost: 20000 });
  });

  it('recomputes a day close from its cash rows and rejects under-reporting', async () => {
    const shop = await seedShop('Close totals');
    await pushOk(shop.till, saleOps(shop, shop.till, 1));
    const now = Date.now();
    const close = (cashSales: number, expected: number) => ({
      id: newId(now),
      device_id: shop.till.id,
      branch_id: shop.branchId,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      period_start: 0,
      period_end: now,
      opening_cash: 0,
      cash_sales: cashSales,
      udhaar_cash_in: 0,
      pay_ins: 0,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 0,
      expected_cash: expected,
      counted_cash: expected,
      difference: 0,
      denominations_json: null,
      note: '',
      created_at: now,
    });
    const short = await pushOk(shop.till, [
      op('day_closes', 'insert', close(0, 0)),
    ]);
    expect(short.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    const full = await pushOk(shop.till, [
      op('day_closes', 'insert', close(150000, 150000)),
    ]);
    expect(full.results[0]?.error_code).toBeUndefined();
  });

  it('writes the money-event audit row when the till omitted it, and rejects a forged amount', async () => {
    const shop = await seedShop('Audit money');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    const saleLineId = String(sale[1]?.row?.id);
    await pushOk(shop.till, sale);
    const refund = (refundId: string, withAudit: boolean, claimed: number) => {
      const tx = newId();
      const row = {
        id: refundId,
        sale_id: saleId,
        kind: 'partial',
        reason: 'Return',
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
      return [
        op('refunds', 'insert', row, { tx_id: tx }),
        op(
          'refund_lines',
          'insert',
          {
            id: newId(),
            refund_id: refundId,
            sale_line_id: saleLineId,
            qty_milli: 1000,
            amount: 1000,
            restock: 0,
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
            purpose: 'refund',
            amount: 1000,
            cash_tendered: null,
            change_given: null,
            reference: '',
            sale_id: saleId,
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
            created_at: Date.now(),
          },
          { tx_id: tx },
        ),
        ...(withAudit
          ? [
              op(
                'audit_log',
                'insert',
                {
                  id: newId(),
                  action: 'refund',
                  entity: 'refunds',
                  entity_id: refundId,
                  before_json: null,
                  after_json: JSON.stringify({
                    sale_id: saleId,
                    reason: 'Return',
                    exact: 1000,
                    udhaar_part: 0,
                    amount: claimed,
                    rounding: 0,
                    method: 'cash',
                  }),
                  device_id: shop.till.id,
                  staff_id: IDS.owner,
                  created_at: Date.now(),
                },
                { tx_id: tx },
              ),
            ]
          : []),
      ];
    };
    const refundId = newId();
    const ok = await pushOk(shop.till, refund(refundId, false, 1000));
    expect(ok.results[0]?.error_code).toBeUndefined();
    const audit = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE tenant_id = ?1 AND action = 'refund' AND entity_id = ?2",
    )
      .bind(shop.tenantId, refundId)
      .first<{ after_json: string }>();
    expect(JSON.parse(String(audit?.after_json))).toMatchObject({
      amount: 1000,
      exact: 1000,
    });
    const forged = await pushOk(shop.till, refund(newId(), true, 5000));
    expect(forged.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('adds a missing purchase movement and still computes the average cost', async () => {
    const shop = await seedShop('Purchase stock repair');
    const now = Date.now();
    const purchaseId = newId(now);
    const tx = newId(now);
    const res = await pushOk(shop.till, [
      op(
        'purchases',
        'insert',
        {
          id: purchaseId,
          supplier_id: IDS.supplier,
          supplier_invoice_no: 'REPAIR-1',
          other_charges: 0,
          total: 2000,
          paid_now: 0,
          paid_method: null,
          line_count: 1,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: '2026-10-27',
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
          unit_cost: 2000,
          line_total: 2000,
          charges_alloc: 0,
          landed_unit_cost: 2000,
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
          amount: 2000,
          source_type: 'purchase',
          source_id: purchaseId,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      ),
    ]);
    expect(res.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
    const product = await env.DB.prepare(
      'SELECT avg_cost, last_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .first<{ avg_cost: number; last_cost: number }>();
    expect(product).toEqual({ avg_cost: 2000, last_cost: 2000 });
    const movement = await env.DB.prepare(
      "SELECT qty_delta_milli, unit_cost FROM stock_movements WHERE tenant_id = ?1 AND ref_id = ?2 AND reason_code = 'purchase'",
    )
      .bind(shop.tenantId, purchaseId)
      .first<{ qty_delta_milli: number; unit_cost: number }>();
    expect(movement).toEqual({ qty_delta_milli: 1000, unit_cost: 2000 });
  });

  it('repairs a refund restock movement and a void return movement', async () => {
    const shop = await seedShop('Refund void repair');
    const sale = saleOps(shop, shop.till, 1);
    const saleId = String(sale[0]?.row?.id);
    const saleLineId = String(sale[1]?.row?.id);
    await pushOk(shop.till, sale);

    const refundId = newId();
    let tx = newId();
    const refund = await pushOk(shop.till, [
      op(
        'refunds',
        'insert',
        {
          id: refundId,
          sale_id: saleId,
          kind: 'partial',
          reason: 'Return',
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
        },
        { tx_id: tx },
      ),
      op(
        'refund_lines',
        'insert',
        {
          id: newId(),
          refund_id: refundId,
          sale_line_id: saleLineId,
          qty_milli: 1000,
          amount: 1000,
          restock: 1,
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
          purpose: 'refund',
          amount: 1000,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: saleId,
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
          created_at: Date.now(),
        },
        { tx_id: tx },
      ),
    ]);
    expect(refund.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
    expect(
      await env.DB.prepare(
        "SELECT qty_delta_milli FROM stock_movements WHERE tenant_id = ?1 AND ref_id = ?2 AND reason_code = 'refund_return'",
      )
        .bind(shop.tenantId, refundId)
        .first<{ qty_delta_milli: number }>(),
    ).toEqual({ qty_delta_milli: 1000 });

    const voidId = newId();
    tx = newId();
    const voided = await pushOk(shop.till, [
      op(
        'sale_voids',
        'insert',
        {
          id: voidId,
          sale_id: saleId,
          reason: 'Wrong bill',
          replacement_sale_id: null,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: '2026-10-27',
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
          staff_id: IDS.owner,
          business_date: '2026-10-27',
          created_at: Date.now(),
        },
        { tx_id: tx },
      ),
    ]);
    expect(voided.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
    ]);
    expect(
      await env.DB.prepare(
        "SELECT qty_delta_milli FROM stock_movements WHERE tenant_id = ?1 AND ref_id = ?2 AND reason_code = 'void_return'",
      )
        .bind(shop.tenantId, voidId)
        .first<{ qty_delta_milli: number }>(),
    ).toEqual({ qty_delta_milli: 1000 });
  });

  it('rejects a pull or snapshot from a client below MIN_CLIENT_SCHEMA', async () => {
    const shop = await seedShop('Schema gate');
    for (const path of ['/sync/pull?since=0', '/sync/snapshot']) {
      const res = await api(path, {
        token: shop.till.token,
        headers: { 'x-bikri-schema': '0' },
      });
      expect(res.status, path).toBe(409);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
        'SCHEMA_OUTDATED',
      );
    }
    expect(
      (await api('/sync/pull?since=0', { token: shop.till.token })).status,
    ).toBe(200);
  });

  it('rejects cash change that does not match the tender', async () => {
    const shop = await seedShop('Cash change');
    const base = saleOps(shop, shop.till, 1);
    const tx = String(base[0]?.tx_id);
    const res = await pushOk(shop.till, [
      op(
        'sales',
        'insert',
        { ...(base[0]?.row ?? {}), cash_tendered: 200000, change_given: 60000 },
        { tx_id: tx },
      ),
      op('sale_lines', 'insert', base[1]?.row ?? {}, { tx_id: tx }),
      op('payments', 'insert', base[2]?.row ?? {}, { tx_id: tx }),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('rejects a bill discount that its type and value do not produce', async () => {
    const shop = await seedShop('Bill discount');
    const base = saleOps(shop, shop.till, 1);
    const tx = String(base[0]?.tx_id);
    const res = await pushOk(shop.till, [
      op(
        'sales',
        'insert',
        {
          ...(base[0]?.row ?? {}),
          bill_discount_type: null,
          bill_discount_value: 0,
          bill_discount: 5000,
          total: 145000,
          paid_total: 145000,
        },
        { tx_id: tx },
      ),
      op('sale_lines', 'insert', base[1]?.row ?? {}, { tx_id: tx }),
      op(
        'payments',
        'insert',
        {
          ...(base[2]?.row ?? {}),
          amount: 145000,
          cash_tendered: 145000,
        },
        { tx_id: tx },
      ),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('chains a day close to the previous drawer period and float', async () => {
    const shop = await seedShop('Close chain');
    await env.DB.prepare(
      `INSERT INTO day_closes (tenant_id, id, device_id, branch_id, staff_id, business_date, period_start, period_end, opening_cash, cash_sales, udhaar_cash_in, pay_ins, supplier_cash_in, cash_refunds, cash_expenses, supplier_cash_out, pay_outs, expected_cash, counted_cash, difference, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '2026-10-27', 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5000, 5000, '', 1000)`,
    )
      .bind(shop.tenantId, newId(), shop.till.id, shop.branchId, IDS.owner)
      .run();
    const close = (
      periodStart: number,
      opening: number,
      at = Date.now(),
      counted = opening,
    ) => ({
      id: newId(),
      device_id: shop.till.id,
      branch_id: shop.branchId,
      staff_id: IDS.owner,
      business_date: '2026-10-27',
      period_start: periodStart,
      period_end: at,
      opening_cash: opening,
      cash_sales: 0,
      udhaar_cash_in: 0,
      pay_ins: 0,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 0,
      expected_cash: opening,
      counted_cash: counted,
      difference: counted - opening,
      denominations_json: null,
      note: '',
      created_at: at,
    });
    const wrong = await pushOk(shop.till, [
      op('day_closes', 'insert', close(999, 5000)),
    ]);
    expect(wrong.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    const first = close(1000, 5000);
    const ok = await pushOk(shop.till, [op('day_closes', 'insert', first)]);
    expect(ok.results[0]?.error_code).toBeUndefined();
    // Two closes replayed in one push chain through each other, not only through D1.
    const second = close(first.period_end, 5000, first.period_end + 1000, 6000);
    const third = close(
      second.period_end,
      6000,
      second.period_end + 1000,
      7000,
    );
    const replay = await pushOk(shop.till, [
      op('day_closes', 'insert', second, { tx_id: second.id }),
      op('day_closes', 'insert', third, { tx_id: third.id }),
    ]);
    expect(replay.results.map((r) => r.error_code ?? null)).toEqual([
      null,
      null,
    ]);
  });
});

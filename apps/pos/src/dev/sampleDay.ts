import { newId } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { defaultBranch, deviceInfo } from '../data/localTenant.ts';
import { writeAction } from '../data/write.ts';

/**
 * A day of figures for Home/Reports checks (dev, tests and e2e only):
 * bill 1 = 2 × Rs 500 cash (cost Rs 300 each), bill 2 = Rs 500 with Rs 200 cash + Rs 300 udhaar
 * (cost Rs 300), a cash refund of 1 item from bill 1, Rs 100 udhaar received and a Rs 50 cash expense.
 * Expected: sold Rs 1,000, 2 bills, profit Rs 400, udhaar given Rs 300 / received Rs 100,
 * cash in drawer Rs 750.
 */
export async function seedSampleDay(
  db: BikriDb,
  date: string,
  now = Date.now(),
): Promise<void> {
  const device = await deviceInfo(db);
  const branch = await defaultBranch(db);
  const owner = (await db.staff.toArray()).find((s) => s.role === 'owner');
  const category = (await db.expense_categories.toArray())[0];
  if (!device || !branch || !owner || !category)
    throw new Error('seedSampleDay needs a set-up shop');
  const base = {
    branch_id: branch.id,
    device_id: device.id,
    staff_id: owner.id,
    business_date: date,
  };
  await writeAction(
    db,
    async (w) => {
      const product = await w.create('products', {
        name: 'Charger',
        sku: 'CHG-1',
        price: 50000,
        track_stock: 0,
      });
      const customer = await w.create('customers', {
        name: 'Bilal',
        phone: '+923001112233',
        credit_limit: null,
      });
      const sale = (
        id: string,
        seq: number,
        total: number,
        paid: number,
        customerId: string | null,
        t: number,
      ) => ({
        ...base,
        id,
        invoice_no: `A-${device.code}-${seq}`,
        invoice_seq: seq,
        customer_id: customerId,
        created_at: t,
        line_count: 1,
        items_qty_milli: 1000,
        gross_total: total,
        item_discount_total: 0,
        subtotal: total,
        bill_discount_type: null,
        bill_discount_value: 0,
        bill_discount: 0,
        tax_rate_bp: 0,
        tax: 0,
        tax_inclusive: 0,
        rounding: 0,
        total,
        paid_total: paid,
        udhaar_amount: total - paid,
        cash_tendered: paid,
        change_given: 0,
        status: 'paid',
        replaces_sale_id: null,
        note: '',
      });
      const line = (
        id: string,
        saleId: string,
        qty: number,
        price: number,
        t: number,
      ) => ({
        id,
        sale_id: saleId,
        line_no: 1,
        product_id: product.id,
        name_snapshot: 'Charger',
        sku_snapshot: '',
        qty_milli: qty,
        unit_price: price,
        gross: (qty / 1000) * price,
        discount_type: null,
        discount_value: 0,
        discount: 0,
        net: (qty / 1000) * price,
        bill_discount_alloc: 0,
        tax_alloc: 0,
        rounding_alloc: 0,
        unit_cost_snapshot: 30000,
        below_cost: 0,
        serial: null,
        warranty_until: null,
        created_at: t,
      });
      const pay = (
        amount: number,
        t: number,
        extra: Record<string, unknown>,
      ) => ({
        ...base,
        id: newId(t),
        method: 'cash',
        amount,
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
        created_at: t,
        ...extra,
      });
      const s1 = newId(now);
      await w.insert('sales', {
        ...sale(s1, 1, 100000, 100000, null, now),
        line_count: 1,
        items_qty_milli: 2000,
      });
      const l1 = newId(now);
      await w.insert('sale_lines', line(l1, s1, 2000, 50000, now));
      await w.insert(
        'payments',
        pay(100000, now, { direction: 'in', purpose: 'sale', sale_id: s1 }),
      );
      const s2 = newId(now + 1);
      await w.insert('sales', sale(s2, 2, 50000, 20000, customer.id, now + 1));
      await w.insert(
        'sale_lines',
        line(newId(now + 1), s2, 1000, 50000, now + 1),
      );
      await w.insert(
        'payments',
        pay(20000, now + 1, { direction: 'in', purpose: 'sale', sale_id: s2 }),
      );
      const entry = (
        amount: number,
        t: number,
        source: string,
        sourceId: string,
      ) => ({
        ...base,
        id: newId(t),
        party_type: 'customer',
        party_id: customer.id,
        amount,
        source_type: source,
        source_id: sourceId,
        note: '',
        created_at: t,
      });
      await w.insert('ledger_entries', entry(30000, now + 1, 'sale', s2));
      const r1 = newId(now + 2);
      await w.insert('refunds', {
        ...base,
        id: r1,
        sale_id: s1,
        kind: 'partial',
        reason: 'Faulty',
        method: 'cash',
        exact_amount: 50000,
        udhaar_part: 0,
        rounding: 0,
        amount: 50000,
        created_at: now + 2,
      });
      await w.insert('refund_lines', {
        id: newId(now + 2),
        refund_id: r1,
        sale_line_id: l1,
        qty_milli: 1000,
        amount: 50000,
        restock: 1,
        created_at: now + 2,
      });
      await w.insert(
        'payments',
        pay(50000, now + 2, {
          direction: 'out',
          purpose: 'refund',
          refund_id: r1,
        }),
      );
      await w.insert(
        'payments',
        pay(10000, now + 3, {
          direction: 'in',
          purpose: 'customer_payment',
          party_type: 'customer',
          party_id: customer.id,
        }),
      );
      await w.insert(
        'ledger_entries',
        entry(-10000, now + 3, 'payment', customer.id),
      );
      await w.insert('expenses', {
        ...base,
        id: newId(now + 4),
        category_id: category.id,
        amount: 5000,
        method: 'cash',
        payee: '',
        note: '',
        reverses_id: null,
        created_at: now + 4,
      });
    },
    { now },
  );
}

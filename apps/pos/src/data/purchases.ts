import {
  businessDate,
  computePurchase,
  newId,
  nextAvgCost,
  type PurchaseLineResult,
} from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { LedgerContext } from './products.ts';
import { writeAction } from './write.ts';

export type DeliveryLineInput = {
  productId: string;
  qtyMilli: number;
  unitCost: number;
  /** Optional new sale price for the product (paisa). */
  updatePrice?: number | null;
};

export type DeliveryInput = {
  purchaseId: string;
  supplierId: string;
  invoiceNo?: string;
  date: string;
  lines: readonly DeliveryLineInput[];
  otherCharges: number;
  paidNow: number;
  paidMethod?: 'cash' | 'card' | 'bank_wallet' | null;
  note?: string;
};

export type DeliveryOptions = {
  today: string;
  now?: number;
};

export class DeliveryError extends Error {
  readonly code:
    | 'supplier'
    | 'lines'
    | 'qty'
    | 'cost'
    | 'date'
    | 'paid'
    | 'method'
    | 'product'
    | 'price';
  constructor(code: DeliveryError['code']) {
    super(code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

const MAX_LINES = 60;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Delivery / purchase recipe (02 §5), one Dexie transaction with its outbox ops. */
export async function saveDelivery(
  db: BikriDb,
  input: DeliveryInput,
  ctx: LedgerContext,
  options: DeliveryOptions,
): Promise<SyncedRow> {
  const existing = await db.purchases.get(input.purchaseId);
  if (existing) return existing;
  if (input.lines.length === 0 || input.lines.length > MAX_LINES)
    throw new DeliveryError('lines');
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.date) ||
    input.date > options.today ||
    input.date < addDays(options.today, -30)
  )
    throw new DeliveryError('date');
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0)
      throw new DeliveryError('qty');
    if (!Number.isSafeInteger(line.unitCost) || line.unitCost < 0)
      throw new DeliveryError('cost');
    if (
      line.updatePrice !== null &&
      line.updatePrice !== undefined &&
      (!Number.isSafeInteger(line.updatePrice) || line.updatePrice < 0)
    )
      throw new DeliveryError('price');
  }
  if (!Number.isSafeInteger(input.otherCharges) || input.otherCharges < 0)
    throw new DeliveryError('paid');
  const result = computePurchase(
    input.lines.map((line) => ({
      qty_milli: line.qtyMilli,
      unit_cost: line.unitCost,
    })),
    input.otherCharges,
  );
  if (
    !Number.isSafeInteger(input.paidNow) ||
    input.paidNow < 0 ||
    input.paidNow > result.total
  )
    throw new DeliveryError('paid');
  if (input.paidNow > 0 && !input.paidMethod) throw new DeliveryError('method');
  if (input.paidNow === 0 && input.paidMethod)
    throw new DeliveryError('method');
  const supplier = await db.suppliers.get(input.supplierId);
  if (!supplier || supplier.deleted_at) throw new DeliveryError('supplier');
  const products = new Map(
    (await db.products.bulkGet(input.lines.map((line) => line.productId)))
      .filter((p): p is MasterRow => p !== undefined)
      .map((p) => [p.id, p]),
  );
  if (input.lines.some((line) => !products.has(line.productId)))
    throw new DeliveryError('product');
  const now = options.now ?? Date.now();
  const date = input.date;

  return writeAction(
    db,
    async (w) => {
      const purchase: SyncedRow = {
        id: input.purchaseId,
        supplier_id: input.supplierId,
        supplier_invoice_no: (input.invoiceNo ?? '').trim().slice(0, 30),
        other_charges: input.otherCharges,
        total: result.total,
        paid_now: input.paidNow,
        paid_method: input.paidNow > 0 ? input.paidMethod : null,
        line_count: input.lines.length,
        note: (input.note ?? '').trim().slice(0, 200),
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: date,
        created_at: now,
      };
      await w.insert('purchases', purchase);
      let lineNo = 0;
      for (const [index, line] of input.lines.entries()) {
        lineNo += 1;
        const priced = result.lines[index] as PurchaseLineResult;
        const product = products.get(line.productId) as MasterRow;
        await w.insert('purchase_lines', {
          id: newId(now),
          purchase_id: input.purchaseId,
          line_no: lineNo,
          product_id: line.productId,
          qty_milli: line.qtyMilli,
          unit_cost: line.unitCost,
          line_total: priced.line_total,
          charges_alloc: priced.charges_alloc,
          landed_unit_cost: priced.landed_unit_cost,
          created_at: now,
        });
        const onHand =
          (
            await w
              .table<{ product_id: string; on_hand_milli: number }>(
                'stock_levels',
              )
              .get(line.productId)
          )?.on_hand_milli ?? 0;
        const patch: Record<string, unknown> = {
          last_cost: line.unitCost,
        };
        if (product.track_stock === 1) {
          patch.avg_cost = nextAvgCost({
            on_hand_milli: onHand,
            avg_cost: Number(product.avg_cost ?? 0),
            qty_milli: line.qtyMilli,
            unit_cost: priced.landed_unit_cost,
          });
          await w.insert('stock_movements', {
            id: newId(now),
            product_id: line.productId,
            qty_delta_milli: line.qtyMilli,
            reason_code: 'purchase',
            ref_type: 'purchase',
            ref_id: input.purchaseId,
            unit_cost: priced.landed_unit_cost,
            note: '',
            branch_id: ctx.branch_id,
            device_id: ctx.device_id,
            staff_id: ctx.staff_id,
            business_date: date,
            created_at: now,
          });
        }
        if (line.updatePrice !== null && line.updatePrice !== undefined) {
          const before = Number(product.price ?? 0);
          if (before !== line.updatePrice) {
            patch.price = line.updatePrice;
            await w.insert('audit_log', {
              id: newId(now),
              action: 'price_change',
              entity: 'products',
              entity_id: line.productId,
              before_json: JSON.stringify({ price: before }),
              after_json: JSON.stringify({ price: line.updatePrice }),
              device_id: ctx.device_id,
              staff_id: ctx.staff_id,
              created_at: now,
            });
          }
        }
        await w.update('products', line.productId, patch);
      }
      await w.insert('ledger_entries', {
        id: newId(now),
        party_type: 'supplier',
        party_id: input.supplierId,
        amount: result.total,
        source_type: 'purchase',
        source_id: input.purchaseId,
        note: purchase.supplier_invoice_no,
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: date,
        created_at: now,
      });
      if (input.paidNow > 0 && input.paidMethod) {
        const paymentId = newId(now);
        await w.insert('payments', {
          id: paymentId,
          direction: 'out',
          method: input.paidMethod,
          purpose: 'purchase_paid_now',
          amount: input.paidNow,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: input.purchaseId,
          supplier_return_id: null,
          party_type: 'supplier',
          party_id: input.supplierId,
          note: '',
          branch_id: ctx.branch_id,
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          business_date: date,
          created_at: now,
        });
        await w.insert('ledger_entries', {
          id: newId(now),
          party_type: 'supplier',
          party_id: input.supplierId,
          amount: -input.paidNow,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
          branch_id: ctx.branch_id,
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          business_date: date,
          created_at: now,
        });
      }
      return purchase;
    },
    { now, actor: ctx.staff_id },
  );
}

export type SupplierPaymentInput = {
  paymentId: string;
  supplierId: string;
  amount: number;
  method: 'cash' | 'card' | 'bank_wallet';
  reference?: string;
  note?: string;
};

export class SupplierPaymentError extends Error {
  readonly code: 'amount' | 'method' | 'supplier';
  constructor(code: SupplierPaymentError['code']) {
    super(code);
    this.name = 'SupplierPaymentError';
    this.code = code;
  }
}

/** Pay supplier (02 §5): payments out + supplier ledger row. */
export async function paySupplier(
  db: BikriDb,
  input: SupplierPaymentInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<SyncedRow> {
  const existing = await db.payments.get(input.paymentId);
  if (existing) return existing;
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new SupplierPaymentError('amount');
  if (!['cash', 'card', 'bank_wallet'].includes(input.method))
    throw new SupplierPaymentError('method');
  const supplier = await db.suppliers.get(input.supplierId);
  if (!supplier || supplier.deleted_at)
    throw new SupplierPaymentError('supplier');
  const date = businessDate(now, ctx.timeZone);
  return writeAction(
    db,
    async (w) => {
      const payment: SyncedRow = {
        id: input.paymentId,
        direction: 'out',
        method: input.method,
        purpose: 'supplier_payment',
        amount: input.amount,
        cash_tendered: null,
        change_given: null,
        reference: (input.reference ?? '').slice(0, 40),
        sale_id: null,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: 'supplier',
        party_id: input.supplierId,
        note: (input.note ?? '').slice(0, 120),
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: date,
        created_at: now,
      };
      await w.insert('payments', payment);
      await w.insert('ledger_entries', {
        id: newId(now),
        party_type: 'supplier',
        party_id: input.supplierId,
        amount: -input.amount,
        source_type: 'payment',
        source_id: input.paymentId,
        note: String(supplier.name),
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: date,
        created_at: now,
      });
      return payment;
    },
    { now, actor: ctx.staff_id },
  );
}

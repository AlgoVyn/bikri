import {
  businessDate,
  computePurchase,
  MAX_LINES_PER_DOCUMENT,
  MAX_OPS_PER_TX,
  newId,
  nextAvgCost,
  type PurchaseLineResult,
} from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import { isBusinessDate } from './dates.ts';
import type { LedgerContext } from './products.ts';
import { writeAction, writeScope } from './write.ts';

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

export type DeliveryDetailLine = {
  line: SyncedRow;
  name: string;
  unit: string;
  qtyMilli: number;
  unitCost: number;
  lineTotal: number;
  chargesAlloc: number;
  landedUnitCost: number;
  /** Quantity already returned against this line through a linked supplier return. */
  returnedMilli: number;
};

export type DeliveryDetail = {
  purchase: SyncedRow;
  supplier: MasterRow;
  lines: DeliveryDetailLine[];
  returns: SyncedRow[];
  balance: number;
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
    | 'price'
    | 'too_many';
  constructor(code: DeliveryError['code']) {
    super(code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

const MAX_LINES = MAX_LINES_PER_DOCUMENT;

/** Stable internal reference used when the supplier did not give an invoice number. */
export function generatedInvoiceNo(purchaseId: string, date: string): string {
  const suffix =
    purchaseId
      .replace(/[^a-z0-9]/giu, '')
      .slice(-6)
      .toUpperCase() || '000000';
  return `BKR-${date.replaceAll('-', '')}-${suffix}`;
}

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
    !isBusinessDate(input.date) ||
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
  for (const line of input.lines) {
    const product = products.get(line.productId);
    if (
      !product ||
      product.deleted_at ||
      String(product.kind ?? 'simple') === 'bundle'
    )
      throw new DeliveryError('product');
  }
  // A delivery is one document and cannot be split across transactions. Refuse up front when the
  // worst case (line + movement + product update + price audit) would exceed the action limit.
  const worstOps =
    1 +
    input.lines.reduce((count, line) => {
      const product = products.get(line.productId);
      const priceChange =
        line.updatePrice !== null &&
        line.updatePrice !== undefined &&
        Number(product?.price ?? 0) !== line.updatePrice;
      return (
        count + 2 + (product?.track_stock === 1 ? 1 : 0) + (priceChange ? 1 : 0)
      );
    }, 0) +
    (result.total > 0 ? 1 : 0) +
    (input.paidNow > 0 ? 2 : 0);
  if (worstOps > MAX_OPS_PER_TX) throw new DeliveryError('too_many');
  const now = options.now ?? Date.now();
  const date = input.date;

  return writeAction(
    db,
    async (w) => {
      const duplicate = (await w.table('purchases').get(input.purchaseId)) as
        | SyncedRow
        | undefined;
      if (duplicate) return duplicate;
      const purchase: SyncedRow = {
        id: input.purchaseId,
        supplier_id: input.supplierId,
        supplier_invoice_no:
          (input.invoiceNo ?? '').trim().slice(0, 30) ||
          generatedInvoiceNo(input.purchaseId, date),
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
      // Duplicate product lines are allowed; average against the running state so the
      // second line does not reuse the pre-action average.
      const costState = new Map<
        string,
        { on_hand: number; avg_cost: number }
      >();
      let lineNo = 0;
      const productIds = [
        ...new Set(input.lines.map((line) => line.productId)),
      ];
      const levelRows = await w
        .table<{ product_id: string; on_hand_milli: number }>('stock_levels')
        .bulkGet(productIds);
      const levels = new Map(
        levelRows.flatMap((level) =>
          level ? [[level.product_id, level.on_hand_milli] as const] : [],
        ),
      );
      const lineRows: SyncedRow[] = [];
      const movementRows: SyncedRow[] = [];
      const auditRows: SyncedRow[] = [];
      const patches = new Map<string, Record<string, unknown>>();
      for (const [index, line] of input.lines.entries()) {
        lineNo += 1;
        const priced = result.lines[index] as PurchaseLineResult;
        const product = products.get(line.productId) as MasterRow;
        lineRows.push({
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
        let state = costState.get(line.productId);
        if (!state) {
          state = {
            on_hand: levels.get(line.productId) ?? 0,
            avg_cost: Number(product.avg_cost ?? 0),
          };
          costState.set(line.productId, state);
        }
        const patch: Record<string, unknown> = {
          // 07 §7: every costed movement sets last_cost to its (landed) unit cost.
          last_cost: priced.landed_unit_cost,
        };
        if (product.track_stock === 1) {
          patch.avg_cost = nextAvgCost({
            on_hand_milli: state.on_hand,
            avg_cost: state.avg_cost,
            qty_milli: line.qtyMilli,
            unit_cost: priced.landed_unit_cost,
          });
          state.on_hand += line.qtyMilli;
          state.avg_cost = Number(patch.avg_cost);
          movementRows.push({
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
            auditRows.push({
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
        patches.set(line.productId, {
          ...(patches.get(line.productId) ?? {}),
          ...patch,
        });
      }
      await w.insertMany('purchase_lines', lineRows);
      if (movementRows.length > 0)
        await w.insertMany('stock_movements', movementRows);
      if (auditRows.length > 0) await w.insertMany('audit_log', auditRows);
      for (const [productId, patch] of patches)
        await w.update('products', productId, patch);
      // A free-of-charge delivery must not write the zero amount the ledger CHECK forbids.
      if (result.total > 0)
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
    {
      now,
      actor: ctx.staff_id,
      tables: writeScope(
        'purchases',
        'purchase_lines',
        'products',
        'stock_movements',
        'stock_levels',
        'audit_log',
        'ledger_entries',
        'party_balances',
        'payments',
      ),
    },
  );
}

/** Read a saved delivery with its lines, linked returns and current supplier balance. */
export async function deliveryDetail(
  db: BikriDb,
  purchaseId: string,
): Promise<DeliveryDetail | null> {
  const purchase = await db.purchases.get(purchaseId);
  if (!purchase) return null;
  const supplier = await db.suppliers.get(String(purchase.supplier_id));
  if (!supplier) return null;
  const lines = (
    await db.purchase_lines.where('purchase_id').equals(purchaseId).toArray()
  ).sort((a, b) => Number(a.line_no) - Number(b.line_no));
  const products = new Map(
    (await db.products.bulkGet(lines.map((line) => String(line.product_id))))
      .filter((row): row is MasterRow => row !== undefined)
      .map((row) => [String(row.id), row]),
  );
  const returns = (
    await db.supplier_returns.where('purchase_id').equals(purchaseId).toArray()
  ).sort((a, b) => Number(a.created_at) - Number(b.created_at));
  const returnedByLine = new Map<string, number>();
  const returnIds = returns.map((row) => String(row.id));
  if (returnIds.length > 0) {
    const returnLines = await db.supplier_return_lines
      .where('return_id')
      .anyOf(returnIds)
      .toArray();
    for (const line of returnLines) {
      if (!line.purchase_line_id) continue;
      const id = String(line.purchase_line_id);
      returnedByLine.set(
        id,
        (returnedByLine.get(id) ?? 0) + Number(line.qty_milli),
      );
    }
  }
  const balance =
    (await db.party_balances.get(['supplier', String(supplier.id)]))?.balance ??
    0;
  return {
    purchase,
    supplier,
    lines: lines.map((line) => {
      const product = products.get(String(line.product_id));
      return {
        line,
        // purchase_lines has no name snapshot; delivery history reads the current
        // catalogue name (documented in screens/13).
        name:
          String(product?.name_en ?? '').trim() ||
          String(product?.name_ur ?? '').trim() ||
          String(product?.sku ?? '').trim() ||
          String(line.product_id),
        unit: String(product?.unit ?? 'pc'),
        qtyMilli: Number(line.qty_milli),
        unitCost: Number(line.unit_cost),
        lineTotal: Number(line.line_total),
        chargesAlloc: Number(line.charges_alloc),
        landedUnitCost: Number(line.landed_unit_cost),
        returnedMilli: returnedByLine.get(String(line.id)) ?? 0,
      };
    }),
    returns,
    balance,
  };
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
      const duplicate = (await w.table('payments').get(input.paymentId)) as
        | SyncedRow
        | undefined;
      if (duplicate) return duplicate;
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
    {
      now,
      actor: ctx.staff_id,
      tables: writeScope('payments', 'ledger_entries', 'party_balances'),
    },
  );
}

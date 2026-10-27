import { businessDate, mulDivRound, newId } from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import type { LedgerContext } from './products.ts';
import { writeAction } from './write.ts';

const n = (value: unknown): number => Number(value ?? 0);

export class SupplierReturnError extends Error {
  readonly code:
    | 'supplier'
    | 'lines'
    | 'qty'
    | 'cost'
    | 'reason'
    | 'total'
    | 'refund'
    | 'method'
    | 'purchase';
  constructor(code: SupplierReturnError['code']) {
    super(code);
    this.name = 'SupplierReturnError';
    this.code = code;
  }
}

export type ReturnableLine = {
  purchaseLine: SyncedRow;
  product: MasterRow;
  received: number;
  returned: number;
  remaining: number;
  landedCost: number;
};

export type ReturnablePurchase = {
  purchase: SyncedRow;
  lines: ReturnableLine[];
};

export type SupplierReturnData = {
  supplier: MasterRow;
  balance: number;
  purchases: ReturnablePurchase[];
  products: MasterRow[];
};

/** Deliveries from the last 180 days with their remaining returnable quantities. */
export async function supplierReturnData(
  db: BikriDb,
  supplierId: string,
  today: string,
): Promise<SupplierReturnData | null> {
  const supplier = await db.suppliers.get(supplierId);
  if (!supplier || supplier.deleted_at) return null;
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 180);
  const purchases = (
    await db.purchases.where('supplier_id').equals(supplierId).toArray()
  )
    .filter(
      (purchase) =>
        String(purchase.business_date) >= cutoff.toISOString().slice(0, 10),
    )
    .sort((a, b) => n(b.created_at) - n(a.created_at));
  const purchaseIds = purchases.map((purchase) => String(purchase.id));
  const purchaseLines =
    purchaseIds.length === 0
      ? []
      : await db.purchase_lines
          .where('purchase_id')
          .anyOf(purchaseIds)
          .toArray();
  const lineIds = purchaseLines.map((line) => String(line.id));
  const returns =
    lineIds.length === 0
      ? []
      : await db.supplier_return_lines
          .where('purchase_line_id')
          .anyOf(lineIds)
          .toArray();
  const returned = new Map<string, number>();
  for (const line of returns) {
    const key = String(line.purchase_line_id);
    returned.set(key, (returned.get(key) ?? 0) + n(line.qty_milli));
  }
  const productIds = [
    ...new Set(purchaseLines.map((line) => String(line.product_id))),
  ];
  const products = new Map(
    (await db.products.bulkGet(productIds))
      .filter((product): product is MasterRow => product !== undefined)
      .map((product) => [product.id, product]),
  );
  const byPurchase = new Map<string, ReturnableLine[]>();
  for (const line of purchaseLines) {
    const product = products.get(String(line.product_id));
    if (!product) continue;
    const returnedQty = returned.get(String(line.id)) ?? 0;
    const list = byPurchase.get(String(line.purchase_id)) ?? [];
    list.push({
      purchaseLine: line,
      product,
      received: n(line.qty_milli),
      returned: returnedQty,
      remaining: Math.max(0, n(line.qty_milli) - returnedQty),
      landedCost: n(line.landed_unit_cost),
    });
    byPurchase.set(String(line.purchase_id), list);
  }
  const allProducts = (await db.products.toArray()).filter(
    (product) => !product.deleted_at,
  );
  const balance = await db.party_balances.get(['supplier', supplierId]);
  return {
    supplier,
    balance: balance?.balance ?? 0,
    purchases: purchases.map((purchase) => ({
      purchase,
      lines: byPurchase.get(String(purchase.id)) ?? [],
    })),
    products: allProducts,
  };
}

export type SupplierReturnLineInput = {
  productId: string;
  purchaseLineId?: string | null;
  qtyMilli: number;
  unitCredit?: number | null;
};

export type SupplierReturnInput = {
  returnId: string;
  supplierId: string;
  purchaseId?: string | null;
  lines: SupplierReturnLineInput[];
  reason: string;
  refundReceived: number;
  refundMethod: 'cash' | 'bank_wallet' | null;
  note?: string;
};

export type SupplierReturnOptions = {
  now?: number;
  today?: string;
};

export type SupplierReturnPlanLine = {
  product: MasterRow;
  purchaseLineId: string | null;
  qtyMilli: number;
  unitCredit: number;
  lineTotal: number;
  costSnapshot: number;
  trackStock: boolean;
};

/** The exact credit, suggested refund and balance after, before anything is written. */
export type SupplierReturnPlan = {
  lines: SupplierReturnPlanLine[];
  total: number;
  suggestedRefund: number;
  balanceBefore: number;
  balanceAfter: number;
};

export async function planSupplierReturn(
  db: BikriDb,
  input: Omit<SupplierReturnInput, 'returnId'>,
): Promise<SupplierReturnPlan> {
  const supplier = await db.suppliers.get(input.supplierId);
  if (!supplier || supplier.deleted_at)
    throw new SupplierReturnError('supplier');
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 120)
    throw new SupplierReturnError('reason');
  if (input.lines.length === 0 || input.lines.length > 60)
    throw new SupplierReturnError('lines');
  const purchase = input.purchaseId
    ? await db.purchases.get(input.purchaseId)
    : undefined;
  if (input.purchaseId && (!purchase || purchase.supplier_id !== supplier.id))
    throw new SupplierReturnError('purchase');
  const productIds = [
    ...new Set(input.lines.map((line) => String(line.productId))),
  ];
  const products = new Map(
    (await db.products.bulkGet(productIds))
      .filter((row): row is MasterRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  let total = 0;
  const lines: SupplierReturnPlanLine[] = [];
  for (const line of input.lines) {
    const product = products.get(line.productId);
    if (!product) throw new SupplierReturnError('supplier');
    if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0)
      throw new SupplierReturnError('qty');
    let linkedCost: number | null = null;
    if (line.purchaseLineId) {
      const purchaseLine = await db.purchase_lines.get(line.purchaseLineId);
      if (
        !purchaseLine ||
        purchaseLine.product_id !== line.productId ||
        (purchase && purchaseLine.purchase_id !== purchase.id)
      )
        throw new SupplierReturnError('purchase');
      linkedCost = n(purchaseLine.landed_unit_cost);
      if (linkedCost <= 0) linkedCost = null;
    }
    const unitCredit =
      line.unitCredit ??
      linkedCost ??
      (n(product.avg_cost) > 0 ? n(product.avg_cost) : n(product.last_cost));
    if (!Number.isSafeInteger(unitCredit) || unitCredit < 0)
      throw new SupplierReturnError('cost');
    const lineTotal = mulDivRound(line.qtyMilli, unitCredit, 1000);
    total += lineTotal;
    lines.push({
      product,
      purchaseLineId: line.purchaseLineId ?? null,
      qtyMilli: line.qtyMilli,
      unitCredit,
      lineTotal,
      costSnapshot: n(product.avg_cost),
      trackStock: product.track_stock === 1,
    });
  }
  if (total <= 0) throw new SupplierReturnError('total');
  const balance = await db.party_balances.get(['supplier', input.supplierId]);
  const balanceBefore = balance?.balance ?? 0;
  const suggestedRefund = Math.max(0, total - Math.max(0, balanceBefore));
  const refundReceived = Math.max(0, input.refundReceived);
  if (refundReceived > total) throw new SupplierReturnError('refund');
  if (refundReceived > 0 && !input.refundMethod)
    throw new SupplierReturnError('method');
  return {
    lines,
    total,
    suggestedRefund,
    balanceBefore,
    balanceAfter: balanceBefore - total + refundReceived,
  };
}

/** One append-only return: credit note, stock out, ledger and optional money back. */
export async function createSupplierReturn(
  db: BikriDb,
  input: SupplierReturnInput,
  ctx: LedgerContext,
  options: SupplierReturnOptions = {},
): Promise<SyncedRow> {
  const existing = await db.supplier_returns.get(input.returnId);
  if (existing) return existing;
  const plan = await planSupplierReturn(db, input);
  const now = options.now ?? Date.now();
  const reason = input.reason.trim();
  const note = (input.note ?? '').trim().slice(0, 200);
  const refundReceived = Math.max(0, input.refundReceived);
  const refundMethod = refundReceived > 0 ? input.refundMethod : null;
  const today = options.today ?? businessDate(now, ctx.timeZone);
  return writeAction(
    db,
    async (w) => {
      const row: SyncedRow = {
        id: input.returnId,
        supplier_id: input.supplierId,
        purchase_id: input.purchaseId ?? null,
        reason,
        total: plan.total,
        refund_received: refundReceived,
        refund_method: refundMethod,
        line_count: plan.lines.length,
        note,
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: today,
        created_at: now,
      };
      await w.insert('supplier_returns', row);
      let lineNo = 0;
      for (const line of plan.lines) {
        lineNo += 1;
        await w.insert('supplier_return_lines', {
          id: newId(now),
          return_id: input.returnId,
          line_no: lineNo,
          product_id: line.product.id,
          purchase_line_id: line.purchaseLineId,
          qty_milli: line.qtyMilli,
          unit_credit: line.unitCredit,
          line_total: line.lineTotal,
          cost_snapshot: line.costSnapshot,
          created_at: now,
        });
        if (line.trackStock) {
          await w.insert('stock_movements', {
            id: newId(now),
            product_id: line.product.id,
            qty_delta_milli: -line.qtyMilli,
            reason_code: 'supplier_return',
            ref_type: 'supplier_return',
            ref_id: input.returnId,
            unit_cost: null,
            note: reason,
            branch_id: ctx.branch_id,
            device_id: ctx.device_id,
            staff_id: ctx.staff_id,
            business_date: row.business_date,
            created_at: now,
          });
        }
      }
      await w.insert('ledger_entries', {
        id: newId(now),
        party_type: 'supplier',
        party_id: input.supplierId,
        amount: -plan.total,
        source_type: 'supplier_return',
        source_id: input.returnId,
        note: reason,
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: today,
        created_at: now,
      });
      if (refundReceived > 0 && refundMethod) {
        const paymentId = newId(now);
        await w.insert('payments', {
          id: paymentId,
          direction: 'in',
          method: refundMethod,
          purpose: 'supplier_refund',
          amount: refundReceived,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: input.returnId,
          party_type: 'supplier',
          party_id: input.supplierId,
          note: reason,
          branch_id: ctx.branch_id,
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          business_date: row.business_date,
          created_at: now,
        });
        await w.insert('ledger_entries', {
          id: newId(now),
          party_type: 'supplier',
          party_id: input.supplierId,
          amount: refundReceived,
          source_type: 'payment',
          source_id: paymentId,
          note: reason,
          branch_id: ctx.branch_id,
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          business_date: today,
          created_at: now,
        });
      }
      await w.insert('audit_log', {
        id: newId(now),
        action: 'supplier_return',
        entity: 'supplier_returns',
        entity_id: input.returnId,
        before_json: null,
        after_json: JSON.stringify({
          total: plan.total,
          refund_received: refundReceived,
          line_count: plan.lines.length,
          reason,
        }),
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        created_at: now,
      });
      return row;
    },
    { now, actor: ctx.staff_id },
  );
}

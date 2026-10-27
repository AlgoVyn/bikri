import {
  businessDate,
  computeRefundLine,
  newId,
  type RefundMethod,
  type RefundRounding,
  saleLineFinal,
  splitRefund,
} from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import type { TableSource } from './caches.ts';
import type { LedgerContext } from './products.ts';
import { queueRefundPrint } from './refundReceipt.ts';
import { writeAction } from './write.ts';

const n = (v: unknown): number => Number(v ?? 0);

export class RefundNotAllowedError extends Error {
  readonly code: 'void' | 'nothing' | 'qty' | 'reason' | 'line' | 'missing';
  constructor(code: RefundNotAllowedError['code']) {
    super(code);
    this.name = 'RefundNotAllowedError';
    this.code = code;
  }
}

export type RefundLineInput = {
  saleLineId: string;
  /** Milli-units to refund; 0 lines are ignored. */
  qtyMilli: number;
  restock: boolean;
};

export type RefundPlanLine = RefundLineInput & {
  name: string;
  unit: string;
  soldMilli: number;
  priorMilli: number;
  /** Exact paisa share of this line (07 §6). */
  amount: number;
  trackStock: boolean;
};

export type RefundPlan = {
  saleId: string;
  kind: 'whole' | 'partial';
  lines: RefundPlanLine[];
  exact: number;
  udhaarPart: number;
  paidExact: number;
  method: RefundMethod | null;
  amount: number;
  rounding: number;
  remainingPaid: number;
  remainingUdhaar: number;
  khataBalance: number;
  khataAfter: number;
};

export type RefundInput = {
  /** Chosen when the dialog opens, so a double click writes one refund. */
  refundId: string;
  saleId: string;
  lines: readonly RefundLineInput[];
  reason: string;
  /** Method of the paid part; ignored when nothing is handed back. */
  method: RefundMethod | null;
  /** Manager approval for `refund.create` (05 §4.1), written in the same action. */
  override?: { approved_by: string } | null;
  print?: boolean;
};

async function roundingOf(src: TableSource): Promise<RefundRounding> {
  const shop = await (src.table('shop') as Table<MasterRow, string>).get(
    'shop',
  );
  const value = String(shop?.refund_rounding ?? 'nearest');
  return value === 'down' || value === 'none' ? value : 'nearest';
}

/**
 * The refund split for a set of lines (07 §6.1), read from the shop's own rows. Runs inside the
 * write transaction too, so the stored amounts are the ones the dialog showed.
 */
export async function computeRefund(
  src: TableSource,
  saleId: string,
  input: readonly RefundLineInput[],
  method: RefundMethod | null,
): Promise<RefundPlan> {
  const sale = await (src.table('sales') as Table<SyncedRow>).get(saleId);
  if (!sale) throw new RefundNotAllowedError('missing');
  if (sale.status === 'void') throw new RefundNotAllowedError('void');
  const lines = (
    await (src.table('sale_lines') as Table<SyncedRow>)
      .where('sale_id')
      .equals(saleId)
      .toArray()
  ).sort((a, b) => n(a.line_no) - n(b.line_no));
  if (lines.length === 0) throw new RefundNotAllowedError('missing');

  const priorRows = (
    await (src.table('refund_lines') as Table<SyncedRow>)
      .where('sale_line_id')
      .anyOf(lines.map((l) => l.id))
      .toArray()
  ).reduce((map, row) => {
    const key = String(row.sale_line_id);
    map.set(key, (map.get(key) ?? 0) + n(row.qty_milli));
    return map;
  }, new Map<string, number>());

  const products = new Map(
    (
      await (src.table('products') as Table<MasterRow>).bulkGet([
        ...new Set(
          lines
            .map((l) => l.product_id)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ])
    )
      .filter((p): p is MasterRow => p !== undefined)
      .map((p) => [p.id, p]),
  );

  const requested = new Map(input.map((line) => [line.saleLineId, line]));
  const planLines: RefundPlanLine[] = [];
  let exact = 0;
  for (const line of lines) {
    const request = requested.get(line.id);
    if (!request || request.qtyMilli <= 0) continue;
    const sold = n(line.qty_milli);
    const prior = priorRows.get(line.id) ?? 0;
    if (request.qtyMilli > sold - prior) throw new RefundNotAllowedError('qty');
    const product = line.product_id
      ? products.get(String(line.product_id))
      : undefined;
    const amount = computeRefundLine(
      saleLineFinal(
        {
          net: n(line.net),
          bill_discount_alloc: n(line.bill_discount_alloc),
          tax_alloc: n(line.tax_alloc),
          rounding_alloc: n(line.rounding_alloc),
        },
        sale.tax_inclusive === 1,
      ),
      sold,
      prior,
      request.qtyMilli,
    );
    exact += amount;
    planLines.push({
      ...request,
      name: String(line.name_snapshot),
      unit: String(product?.unit ?? 'pc'),
      soldMilli: sold,
      priorMilli: prior,
      amount,
      trackStock: product?.track_stock === 1,
    });
  }
  if (planLines.length === 0) throw new RefundNotAllowedError('nothing');
  const unknown = input.find(
    (line) => line.qtyMilli > 0 && !lines.some((l) => l.id === line.saleLineId),
  );
  if (unknown) throw new RefundNotAllowedError('line');

  const priorRefunds = (
    await (src.table('refunds') as Table<SyncedRow>)
      .where('sale_id')
      .equals(saleId)
      .toArray()
  ).map((r) => ({ amount: n(r.amount), udhaar_part: n(r.udhaar_part) }));
  const split = splitRefund({
    exact,
    paid_total: n(sale.paid_total),
    udhaar_amount: n(sale.udhaar_amount),
    prior_refunds: priorRefunds,
    method,
    refund_rounding: await roundingOf(src),
  });
  const customerId = sale.customer_id ? String(sale.customer_id) : null;
  const balance = customerId
    ? ((
        (await src.table('party_balances').get(['customer', customerId])) as
          | { balance: number }
          | undefined
      )?.balance ?? 0)
    : 0;
  const whole =
    lines.length > 0 &&
    lines.every((line) => {
      const linePlan = planLines.find((p) => p.saleLineId === line.id);
      const prior = priorRows.get(line.id) ?? 0;
      return prior + (linePlan?.qtyMilli ?? 0) === n(line.qty_milli);
    });
  return {
    saleId,
    kind: whole ? 'whole' : 'partial',
    lines: planLines,
    exact: split.exact,
    udhaarPart: split.udhaar_part,
    paidExact: split.paid_exact,
    method: split.method,
    amount: split.amount,
    rounding: split.rounding,
    remainingPaid: Math.max(
      0,
      n(sale.paid_total) - priorRefunds.reduce((s, r) => s + r.amount, 0),
    ),
    remainingUdhaar: Math.max(
      0,
      n(sale.udhaar_amount) -
        priorRefunds.reduce((s, r) => s + r.udhaar_part, 0),
    ),
    khataBalance: balance,
    khataAfter: balance - split.udhaar_part,
  };
}

export type RefundResult = {
  refund: SyncedRow;
  plan: RefundPlan;
  created: boolean;
};

/** Refund recipe (02 §5), one Dexie transaction with its outbox ops. */
export async function refundSale(
  db: BikriDb,
  input: RefundInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<RefundResult> {
  const existing = await db.refunds.get(input.refundId);
  if (existing) {
    return {
      refund: existing,
      plan: await computeRefund(db, input.saleId, input.lines, input.method),
      created: false,
    };
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 120)
    throw new RefundNotAllowedError('reason');

  const result = await writeAction(
    db,
    async (w) => {
      const plan = await computeRefund(
        w,
        input.saleId,
        input.lines,
        input.method,
      );
      if (plan.exact <= 0) throw new RefundNotAllowedError('nothing');
      const sale = await (w.table('sales') as Table<SyncedRow>).get(
        input.saleId,
      );
      if (!sale) throw new RefundNotAllowedError('missing');
      const shop = await (w.table('shop') as Table<MasterRow>).get('shop');
      const timeZone =
        String(shop?.timezone ?? 'Asia/Karachi') || 'Asia/Karachi';
      const date = businessDate(now, timeZone);
      const base = {
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: date,
        created_at: now,
      };
      const refundRow: SyncedRow = {
        ...base,
        id: input.refundId,
        sale_id: input.saleId,
        kind: plan.kind,
        reason,
        method: plan.method,
        exact_amount: plan.exact,
        udhaar_part: plan.udhaarPart,
        rounding: plan.rounding,
        amount: plan.amount,
      };
      await w.insert('refunds', refundRow);
      for (const line of plan.lines) {
        await w.insert('refund_lines', {
          ...base,
          id: newId(w.now),
          refund_id: input.refundId,
          sale_line_id: line.saleLineId,
          qty_milli: line.qtyMilli,
          amount: line.amount,
          restock: line.restock ? 1 : 0,
        });
      }
      if (plan.amount > 0 && plan.method) {
        await w.insert('payments', {
          ...base,
          id: newId(w.now),
          direction: 'out',
          method: plan.method,
          purpose: 'refund',
          amount: plan.amount,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: input.saleId,
          refund_id: input.refundId,
          purchase_id: null,
          supplier_return_id: null,
          party_type: sale.customer_id ? 'customer' : null,
          party_id: sale.customer_id ? String(sale.customer_id) : null,
          note: '',
        });
      }
      if (plan.udhaarPart > 0 && sale.customer_id) {
        await w.insert('ledger_entries', {
          ...base,
          id: newId(w.now),
          party_type: 'customer',
          party_id: String(sale.customer_id),
          amount: -plan.udhaarPart,
          source_type: 'refund',
          source_id: input.refundId,
          note: String(sale.invoice_no),
        });
      }
      for (const line of plan.lines) {
        if (!line.restock || !line.trackStock) continue;
        const source = (
          await (w.table('sale_lines') as Table<SyncedRow>).get(line.saleLineId)
        )?.product_id;
        if (typeof source !== 'string') continue;
        await w.insert('stock_movements', {
          ...base,
          id: newId(w.now),
          product_id: source,
          qty_delta_milli: line.qtyMilli,
          reason_code: 'refund_return',
          ref_type: 'refund',
          ref_id: input.refundId,
          unit_cost: null,
          note: '',
        });
      }
      if (input.override) {
        await w.insert('audit_log', {
          id: newId(w.now),
          action: 'override',
          entity: 'refunds',
          entity_id: input.refundId,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'refund.create',
            approved_by: input.override.approved_by,
          }),
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          created_at: now,
        });
      }
      await w.insert('audit_log', {
        id: newId(w.now),
        action: 'refund',
        entity: 'refunds',
        entity_id: input.refundId,
        before_json: null,
        after_json: JSON.stringify({
          sale_id: input.saleId,
          reason,
          exact: plan.exact,
          udhaar_part: plan.udhaarPart,
          amount: plan.amount,
          rounding: plan.rounding,
          method: plan.method,
        }),
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        created_at: now,
      });
      // The sale's status is a derived cache; the server recomputes it on push (03 §6).
      const allRefunds = await (w.table('refunds') as Table<SyncedRow>)
        .where('sale_id')
        .equals(input.saleId)
        .toArray();
      const refundedExact = allRefunds.reduce(
        (s, r) => s + n(r.exact_amount),
        0,
      );
      await (w.table('sales') as Table<SyncedRow>).update(input.saleId, {
        status: refundedExact >= n(sale.total) ? 'refunded' : 'part_refunded',
      });
      return { refundRow, plan };
    },
    { now, actor: ctx.staff_id },
  );

  if (input.print) await queueRefundPrint(db, input.refundId, { now });
  return { refund: result.refundRow, plan: result.plan, created: true };
}

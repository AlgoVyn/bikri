import { businessDate, newId, type Role } from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import type { TableSource } from './caches.ts';
import type { LedgerContext } from './products.ts';
import { type Writer, writeAction } from './write.ts';

const n = (v: unknown): number => Number(v ?? 0);

export class VoidNotAllowedError extends Error {
  readonly code:
    | 'missing'
    | 'refunded'
    | 'voided'
    | 'same_day'
    | 'reason'
    | 'forbidden';
  constructor(code: VoidNotAllowedError['code']) {
    super(code);
    this.name = 'VoidNotAllowedError';
    this.code = code;
  }
}

export type VoidPlan = {
  sale: SyncedRow;
  /** The sale's own incoming payment rows, reversed by the void. */
  payments: SyncedRow[];
  lines: SyncedRow[];
  udhaar: number;
  productOf: Map<string, string>;
};

export type VoidBlocker =
  | 'refunded'
  | 'voided'
  | 'same_day'
  | 'forbidden'
  | null;

/** Whether this staff may void this bill, mirroring the server rules (04 §5, 05 §5). */
export function voidBlocker(
  detail: { sale: SyncedRow; refunds: readonly unknown[] },
  role: Role,
  today: string,
  allowed: boolean,
  override = false,
): VoidBlocker {
  if (detail.sale.status === 'void') return 'voided';
  if (detail.refunds.length > 0) return 'refunded';
  if (!allowed && !override) return 'forbidden';
  if (
    role === 'manager' &&
    !override &&
    String(detail.sale.business_date) !== today
  )
    return 'same_day';
  return null;
}

/** The rows a void will reverse, read inside the write transaction (02 §5). */
export async function computeVoid(
  src: TableSource,
  saleId: string,
  options: { staffId: string; override?: boolean; now?: number },
): Promise<VoidPlan> {
  const sale = await (src.table('sales') as Table<SyncedRow>).get(saleId);
  if (!sale) throw new VoidNotAllowedError('missing');
  const existing = await (src.table('sale_voids') as Table<SyncedRow>)
    .where('sale_id')
    .equals(saleId)
    .first();
  if (existing) throw new VoidNotAllowedError('voided');
  const refunds = await (src.table('refunds') as Table<SyncedRow>)
    .where('sale_id')
    .equals(saleId)
    .count();
  if (refunds > 0) throw new VoidNotAllowedError('refunded');
  const staff = await (src.table('staff') as Table<MasterRow>).get(
    options.staffId,
  );
  const role = (staff?.role ?? 'cashier') as Role;
  let allowed = role === 'owner' || role === 'manager';
  if (staff) {
    try {
      const overrides = JSON.parse(
        String(staff.permissions_json ?? '{}'),
      ) as Record<string, unknown>;
      if (typeof overrides['sale.void'] === 'boolean')
        allowed = overrides['sale.void'];
    } catch {
      // Bad JSON falls back to the role default.
    }
  }
  if (!allowed && !options.override) throw new VoidNotAllowedError('forbidden');
  const shop = await (src.table('shop') as Table<MasterRow>).get('shop');
  const timeZone = String(shop?.timezone ?? 'Asia/Karachi') || 'Asia/Karachi';
  if (
    role === 'manager' &&
    !options.override &&
    String(sale.business_date) !==
      businessDate(options.now ?? Date.now(), timeZone)
  )
    throw new VoidNotAllowedError('same_day');

  const payments = (
    await (src.table('payments') as Table<SyncedRow>)
      .where('sale_id')
      .equals(saleId)
      .toArray()
  )
    .filter((p) => p.direction === 'in' && p.purpose === 'sale')
    .sort(
      (a, b) =>
        n(a.created_at) - n(b.created_at) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const lines = await (src.table('sale_lines') as Table<SyncedRow>)
    .where('sale_id')
    .equals(saleId)
    .sortBy('line_no');
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
  const tracked = new Set(
    (
      await (src.table('stock_movements') as Table<SyncedRow>)
        .filter(
          (row) =>
            row.ref_type === 'sale' &&
            String(row.ref_id) === saleId &&
            n(row.qty_delta_milli) < 0,
        )
        .toArray()
    ).map((row) => String(row.product_id)),
  );
  const productOf = new Map<string, string>();
  for (const line of lines) {
    const product = line.product_id
      ? products.get(String(line.product_id))
      : undefined;
    if (product && tracked.has(product.id))
      productOf.set(line.id, String(line.product_id));
  }
  return { sale, payments, lines, udhaar: n(sale.udhaar_amount), productOf };
}

/** Writes the void's rows inside an existing action (a plain void or a reissue). */
export async function writeVoidRows(
  w: Writer,
  plan: VoidPlan,
  ctx: LedgerContext,
  options: {
    voidId: string;
    reason: string;
    timeZone: string;
    replacementSaleId?: string | null;
    override?: { approved_by: string } | null;
  },
): Promise<SyncedRow> {
  const sale = plan.sale;
  const date = businessDate(w.now, options.timeZone);
  const base = {
    branch_id: ctx.branch_id,
    device_id: ctx.device_id,
    staff_id: ctx.staff_id,
    business_date: date,
    created_at: w.now,
  };
  const voidRow: SyncedRow = {
    id: options.voidId,
    sale_id: sale.id,
    reason: options.reason,
    replacement_sale_id: options.replacementSaleId ?? null,
    device_id: ctx.device_id,
    staff_id: ctx.staff_id,
    business_date: date,
    created_at: w.now,
  };
  await w.insert('sale_voids', voidRow);
  for (const payment of plan.payments) {
    await w.insert('payments', {
      ...base,
      id: newId(w.now),
      direction: 'out',
      method: String(payment.method),
      purpose: 'void',
      amount: n(payment.amount),
      cash_tendered: null,
      change_given: null,
      reference: '',
      sale_id: String(sale.id),
      refund_id: null,
      purchase_id: null,
      supplier_return_id: null,
      party_type: sale.customer_id ? 'customer' : null,
      party_id: sale.customer_id ? String(sale.customer_id) : null,
      note: '',
    });
  }
  if (plan.udhaar > 0 && sale.customer_id) {
    await w.insert('ledger_entries', {
      ...base,
      id: newId(w.now),
      party_type: 'customer',
      party_id: String(sale.customer_id),
      amount: -plan.udhaar,
      source_type: 'void',
      source_id: options.voidId,
      note: String(sale.invoice_no),
    });
  }
  for (const line of plan.lines) {
    const productId = plan.productOf.get(line.id);
    if (!productId) continue;
    await w.insert('stock_movements', {
      ...base,
      id: newId(w.now),
      product_id: productId,
      qty_delta_milli: n(line.qty_milli),
      reason_code: 'void_return',
      ref_type: 'void',
      ref_id: options.voidId,
      unit_cost: null,
      note: '',
    });
  }
  if (options.override) {
    await w.insert('audit_log', {
      id: newId(w.now),
      action: 'override',
      entity: 'sale_voids',
      entity_id: sale.id,
      before_json: null,
      after_json: JSON.stringify({
        permission: 'sale.void',
        approved_by: options.override.approved_by,
      }),
      device_id: ctx.device_id,
      staff_id: ctx.staff_id,
      created_at: w.now,
    });
  }
  await w.insert('audit_log', {
    id: newId(w.now),
    action: 'void',
    entity: 'sale_voids',
    entity_id: sale.id,
    before_json: null,
    after_json: JSON.stringify({
      sale_id: sale.id,
      reason: options.reason,
      replacement_sale_id: options.replacementSaleId ?? null,
    }),
    device_id: ctx.device_id,
    staff_id: ctx.staff_id,
    created_at: w.now,
  });
  await (w.table('sales') as Table<SyncedRow>).update(String(sale.id), {
    status: 'void',
  });
  return voidRow;
}

export type VoidInput = {
  voidId: string;
  saleId: string;
  reason: string;
  override?: { approved_by: string } | null;
};

/** Void recipe (02 §5): one Dexie transaction with the reversing rows and their outbox ops. */
export async function voidSale(
  db: BikriDb,
  input: VoidInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<{ voidRow: SyncedRow; created: boolean }> {
  const existing = await db.sale_voids
    .where('sale_id')
    .equals(input.saleId)
    .first();
  if (existing) return { voidRow: existing, created: false };
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 120)
    throw new VoidNotAllowedError('reason');
  const voidRow = await writeAction(
    db,
    async (w) => {
      const plan = await computeVoid(w, input.saleId, {
        staffId: ctx.staff_id,
        override: input.override != null,
        now,
      });
      const shop = await (w.table('shop') as Table<MasterRow>).get('shop');
      const timeZone =
        String(shop?.timezone ?? 'Asia/Karachi') || 'Asia/Karachi';
      return writeVoidRows(w, plan, ctx, {
        voidId: input.voidId,
        reason,
        timeZone,
        override: input.override,
      });
    },
    { now, actor: ctx.staff_id },
  );
  return { voidRow, created: true };
}

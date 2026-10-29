import {
  businessDate,
  type CartResult,
  creditLimitCheck,
  newId,
} from '@bikri/core';
import type { BikriDb, Cart, CartLine, MasterRow, SyncedRow } from '@bikri/db';
import {
  type CartId,
  CartNotEmptyError,
  cartTotals,
  emptyCart,
  type ShopMoney,
  shopMoney,
  unitCostOf,
} from './cart.ts';
import { deviceInfo } from './localTenant.ts';
import type { LedgerContext } from './products.ts';
import { computeVoid, writeVoidRows } from './voids.ts';
import { writeAction } from './write.ts';

export type PayMethod = 'cash' | 'bank_wallet' | 'card' | 'udhaar';
export const PAY_METHODS: readonly PayMethod[] = [
  'cash',
  'bank_wallet',
  'card',
  'udhaar',
];
export const WALLET_PROVIDERS = [
  'JazzCash',
  'Easypaisa',
  'NayaPay',
  'Bank transfer',
  'Other',
] as const;

/** One row of the pay screen. For cash `amount` is what the customer handed over. */
export type PayRow = {
  method: PayMethod;
  amount: number;
  reference?: string;
  provider?: string;
  last4?: string;
};

export type Settlement = {
  /** Cash, card and wallet applied to the bill (payments rows). */
  applied: Record<'cash' | 'card' | 'bank_wallet', number>;
  udhaar: number;
  cashTendered: number;
  change: number;
  /** Still to collect (> 0) — the Done button stays disabled. */
  remaining: number;
  /** Card/wallet/udhaar together exceed the total. */
  overpaid: boolean;
  paidTotal: number;
  valid: boolean;
};

/** Two rows of the same method are merged (screens/06); references are joined. */
export function mergeRows(rows: readonly PayRow[]): PayRow[] {
  const out: PayRow[] = [];
  for (const row of rows) {
    const same = out.find((r) => r.method === row.method);
    if (!same) {
      out.push({ ...row });
      continue;
    }
    same.amount += row.amount;
    for (const k of ['reference', 'provider', 'last4'] as const) {
      const a = same[k];
      const b = row[k];
      if (b && a !== b) same[k] = a ? `${a}, ${b}` : b;
    }
  }
  return out;
}

/** Applies the rows to `total` per 07 §4: only cash can exceed what is due (change). */
export function settle(total: number, rows: readonly PayRow[]): Settlement {
  const sum = (m: PayMethod) =>
    rows.filter((r) => r.method === m).reduce((s, r) => s + r.amount, 0);
  const card = sum('card');
  const bank = sum('bank_wallet');
  const udhaar = sum('udhaar');
  const nonCash = card + bank + udhaar;
  const cashTendered = sum('cash');
  const cashDue = Math.max(0, total - nonCash);
  const cash = cashDue > 0 ? Math.min(cashTendered, cashDue) : 0;
  const overpaid = nonCash > total;
  const remaining = overpaid ? 0 : cashDue - cash;
  const cashCoversNothing = cashDue === 0 && cashTendered > 0;
  return {
    applied: { cash, card, bank_wallet: bank },
    udhaar,
    cashTendered,
    change: cashDue > 0 ? cashTendered - cash : 0,
    remaining,
    overpaid,
    paidTotal: cash + card + bank,
    valid: !overpaid && !cashCoversNothing && remaining === 0 && total > 0,
  };
}

export class SaleInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SaleInvalidError';
  }
}

export type SaleInput = {
  /** Chosen when the pay screen opens; a second Done with the same id writes nothing (AC 5). */
  saleId: string;
  cartId: CartId;
  cart: Cart;
  money: ShopMoney;
  rows: readonly PayRow[];
  note?: string;
  print: boolean;
  /** Staff limit, to log `discount_over_limit` (07 §3.1). */
  maxDiscountBp: number;
};

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type SaleResult = { sale: SyncedRow; created: boolean };

/** Sale recipe (02 §5): one Dexie transaction with its outbox ops; then the cart tab is empty. */
export async function completeSale(
  db: BikriDb,
  input: SaleInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<SaleResult> {
  const existing = await db.sales.get(input.saleId);
  if (existing) return { sale: existing, created: false };
  const { cart, money } = input;
  if (cart.lines.length === 0) throw new SaleInvalidError('empty cart');
  const totals: CartResult = cartTotals(cart, money);
  const rows = mergeRows(input.rows);
  const s = settle(totals.total, rows);
  if (!s.valid) throw new SaleInvalidError('payments do not cover the total');
  if (s.udhaar > 0 && !cart.customer_id)
    throw new SaleInvalidError('udhaar needs a customer');
  const device = await deviceInfo(db);
  const branch = await db.branches.get(ctx.branch_id);
  if (!device || !branch) throw new SaleInvalidError('device not set up');
  const shop = await db.shop.get('shop');
  const timeZone =
    ctx.timeZone ?? (String(shop?.timezone ?? '').trim() || 'Asia/Karachi');
  const date = businessDate(now, timeZone);
  const reissue = cart.reissue ?? null;
  const voidOverride = cart.overrides?.find(
    (o) => o.permission === 'sale.void',
  );
  const base = {
    branch_id: ctx.branch_id,
    device_id: ctx.device_id,
    staff_id: ctx.staff_id,
    business_date: date,
    created_at: now,
  };
  const productIds = [
    ...new Set(
      cart.lines
        .map((l) => l.product_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const products = new Map<string, MasterRow>();
  for (const p of await db.products.bulkGet(productIds))
    if (p) products.set(p.id, p);

  const sale = await writeAction(
    db,
    async (w) => {
      // Void & reissue (screens/10): the old bill's reversal is part of this same action.
      const reissuePlan = reissue
        ? await computeVoid(w, reissue.sale_id, {
            staffId: ctx.staff_id,
            override: voidOverride !== undefined,
            now,
          })
        : null;
      const kv = w.table<{ key: string; value: unknown }>('kv');
      const seq = Number((await kv.get('invoice_seq'))?.value ?? 0) + 1;
      await kv.put({ key: 'invoice_seq', value: seq });
      const bill =
        cart.bill_discount && cart.bill_discount.value > 0
          ? cart.bill_discount
          : null;
      const saleRow: SyncedRow = {
        ...base,
        id: input.saleId,
        invoice_no: `${String(branch.bill_prefix ?? 'A')}-${device.code}-${seq}`,
        invoice_seq: seq,
        customer_id: cart.customer_id ?? null,
        line_count: cart.lines.length,
        items_qty_milli: cart.lines.reduce((n, l) => n + l.qty_milli, 0),
        gross_total: totals.gross_total,
        item_discount_total: totals.item_discount_total,
        subtotal: totals.subtotal,
        bill_discount_type: bill
          ? bill.type === 'percent'
            ? 'pct'
            : 'rs'
          : null,
        bill_discount_value: bill?.value ?? 0,
        bill_discount: totals.bill_discount,
        tax_rate_bp: money.tax_rate_bp,
        tax: totals.tax,
        tax_inclusive: money.tax_mode === 'inclusive' ? 1 : 0,
        rounding: totals.rounding,
        total: totals.total,
        paid_total: s.paidTotal,
        udhaar_amount: s.udhaar,
        cash_tendered: s.cashTendered,
        change_given: s.change,
        status: 'paid',
        replaces_sale_id: reissue ? reissue.sale_id : null,
        note: (input.note ?? '').trim().slice(0, 120),
      };
      await w.insert('sales', saleRow);
      // Cart lines are newest-first; the bill lists them in the order they were added.
      const ordered = cart.lines
        .map((line, i) => ({ line, r: totals.lines[i] }))
        .reverse();
      let lineNo = 0;
      for (const { line, r } of ordered) {
        if (!r) continue;
        lineNo += 1;
        const product = line.product_id
          ? products.get(line.product_id)
          : undefined;
        const warranty = Number(product?.warranty_days ?? 0);
        const discounted = line.discount_type && line.discount_value > 0;
        await w.insert('sale_lines', {
          id: newId(now),
          sale_id: input.saleId,
          line_no: lineNo,
          product_id: line.product_id,
          name_snapshot: line.name,
          sku_snapshot: line.sku,
          qty_milli: line.qty_milli,
          unit_price: line.unit_price,
          gross: r.gross,
          discount_type: discounted
            ? line.discount_type === 'percent'
              ? 'pct'
              : 'rs'
            : null,
          discount_value: discounted ? line.discount_value : 0,
          discount: r.discount,
          net: r.net,
          bill_discount_alloc: r.bill_discount_alloc,
          tax_alloc: r.tax_alloc,
          rounding_alloc: r.rounding_alloc,
          unit_cost_snapshot: line.unit_cost,
          below_cost: r.below_cost,
          serial: line.note ? line.note : null,
          warranty_until: warranty > 0 ? addDays(date, warranty) : null,
          created_at: now,
        });
        if (product && product.track_stock === 1) {
          await w.insert('stock_movements', {
            ...base,
            id: newId(now),
            product_id: product.id,
            qty_delta_milli: -line.qty_milli,
            reason_code: 'sale',
            ref_type: 'sale',
            ref_id: input.saleId,
            unit_cost: null,
            note: '',
          });
        }
      }
      for (const method of ['cash', 'bank_wallet', 'card'] as const) {
        const amount = s.applied[method];
        if (amount <= 0) continue;
        const row = rows.find((r) => r.method === method);
        await w.insert('payments', {
          ...base,
          id: newId(now),
          direction: 'in',
          method,
          purpose: 'sale',
          amount,
          cash_tendered: method === 'cash' ? s.cashTendered : null,
          change_given: method === 'cash' ? s.change : null,
          reference: [row?.reference, row?.last4 ? `****${row.last4}` : '']
            .filter(Boolean)
            .join(' ')
            .slice(0, 40),
          sale_id: input.saleId,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: null,
          party_type: cart.customer_id ? 'customer' : null,
          party_id: cart.customer_id ?? null,
          note: method === 'bank_wallet' ? (row?.provider ?? '') : '',
        });
      }
      if (s.udhaar > 0 && cart.customer_id) {
        await w.insert('ledger_entries', {
          ...base,
          id: newId(now),
          party_type: 'customer',
          party_id: cart.customer_id,
          amount: s.udhaar,
          source_type: 'sale',
          source_id: input.saleId,
          note: saleRow.invoice_no,
        });
      }
      const audit = (action: string, after: unknown) =>
        w.insert('audit_log', {
          id: newId(now),
          action,
          entity: 'sales',
          entity_id: input.saleId,
          before_json: null,
          after_json: JSON.stringify(after),
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          created_at: now,
        });
      for (const o of cart.overrides ?? [])
        if (o.permission !== 'sale.void') await audit('override', o);
      if (totals.discount_share_bp > input.maxDiscountBp)
        await audit('discount_over_limit', {
          discount_share_bp: totals.discount_share_bp,
          limit_bp: input.maxDiscountBp,
          approved_by:
            cart.overrides?.find((o) => o.permission === 'sale.discount')
              ?.approved_by ?? null,
        });
      if (reissue && reissuePlan) {
        await writeVoidRows(w, reissuePlan, ctx, {
          voidId: reissue.void_id,
          reason: reissue.reason,
          timeZone,
          replacementSaleId: input.saleId,
          override: voidOverride
            ? { approved_by: voidOverride.approved_by }
            : null,
        });
      }
      await w.table<Cart, string>('carts').put(emptyCart(input.cartId, now));
      return saleRow;
    },
    { now, actor: ctx.staff_id },
  );
  // 06 §9: the print job is a separate, best-effort write; the sale is already committed.
  if (input.print)
    await db.print_jobs
      .put({
        id: newId(now),
        sale_id: input.saleId,
        kind: 'sale',
        status: 'queued',
        created_at: now,
      })
      .catch(() => undefined);
  return { sale, created: true };
}

export class ReissueNotAllowedError extends Error {
  readonly code: 'missing' | 'voided' | 'refunded' | 'reason' | 'cart';
  constructor(code: ReissueNotAllowedError['code']) {
    super(code);
    this.name = 'ReissueNotAllowedError';
    this.code = code;
  }
}

/**
 * Opens "Void & reissue" (screens/10): writes the original bill's lines and discounts into a free
 * cart tab. Nothing is voided until the new sale is paid, so Cancel writes nothing.
 */
export async function startReissue(
  db: BikriDb,
  input: {
    saleId: string;
    cartId: CartId;
    reason: string;
    now?: number;
  },
): Promise<Cart> {
  const now = input.now ?? Date.now();
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 120)
    throw new ReissueNotAllowedError('reason');
  const sale = await db.sales.get(input.saleId);
  if (!sale) throw new ReissueNotAllowedError('missing');
  if (sale.status === 'void') throw new ReissueNotAllowedError('voided');
  const refunds = await db.refunds
    .where('sale_id')
    .equals(input.saleId)
    .count();
  if (refunds > 0) throw new ReissueNotAllowedError('refunded');
  const target = await db.carts.get(input.cartId);
  if (target && target.lines.length > 0) throw new CartNotEmptyError();
  // The cart stores newest-first and `createSale` reverses it back to line order.
  const lines = (
    await db.sale_lines.where('sale_id').equals(input.saleId).sortBy('line_no')
  ).reverse();
  const products = new Map(
    (
      await db.products.bulkGet([
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
  const shop = await db.shop.get('shop');
  const money = shopMoney(shop);
  const cartLines: CartLine[] = lines.map((line) => {
    const product = line.product_id
      ? products.get(String(line.product_id))
      : undefined;
    return {
      key: newId(now),
      product_id: line.product_id ? String(line.product_id) : null,
      name: String(line.name_snapshot),
      sku: String(line.sku_snapshot),
      qty_milli: Number(line.qty_milli),
      unit_price: Number(line.unit_price),
      ...(line.discount_type === 'pct'
        ? { discount_type: 'percent' as const }
        : line.discount_type === 'rs'
          ? { discount_type: 'amount' as const }
          : {}),
      discount_value: Number(line.discount_value ?? 0),
      unit_cost: product
        ? unitCostOf(product, money.cost_method)
        : Number(line.unit_cost_snapshot ?? 0),
      ...(product?.image_key ? { image_key: String(product.image_key) } : {}),
      list_price: product ? Number(product.price) : Number(line.unit_price),
      ...(line.serial ? { note: String(line.serial) } : {}),
      track_stock: product?.track_stock === 1 ? 1 : 0,
      unit: String(product?.unit ?? 'pc'),
    };
  });
  const discountValue = Number(sale.bill_discount_value ?? 0);
  const cart: Cart = {
    id: input.cartId,
    customer_id: sale.customer_id ? String(sale.customer_id) : null,
    lines: cartLines,
    bill_discount:
      sale.bill_discount_type === 'pct' && discountValue > 0
        ? { type: 'percent', value: discountValue }
        : sale.bill_discount_type === 'rs' && discountValue > 0
          ? { type: 'amount', value: discountValue }
          : null,
    note: String(sale.note ?? ''),
    updated_at: now,
    reissue: {
      sale_id: input.saleId,
      void_id: newId(now),
      reason,
    },
  };
  await db.carts.put(cart);
  return cart;
}

/** Credit check for the udhaar part (07 §4.1). */
export async function udhaarCheck(
  db: BikriDb,
  customerId: string,
  udhaar: number,
) {
  const c = await db.customers.get(customerId);
  const bal =
    (await db.party_balances.get(['customer', customerId]))?.balance ?? 0;
  const limit =
    c?.credit_limit === null || c?.credit_limit === undefined
      ? null
      : Number(c.credit_limit);
  return {
    balance: bal,
    limit,
    ...creditLimitCheck(bal, udhaar, limit, Number(c?.hard_limit ?? 0) === 1),
  };
}

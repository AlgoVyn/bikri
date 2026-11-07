import {
  businessDate,
  type CartResult,
  can,
  creditLimitCheck,
  isBelowCost,
  MAX_OPS_PER_TX,
  newId,
} from '@bikri/core';
import type { BikriDb, Cart, CartLine, MasterRow, SyncedRow } from '@bikri/db';
import { addDays, BACKDATE_REASON_MAX, isBusinessDate } from './backdate.ts';
import {
  type CartId,
  CartNotEmptyError,
  cartTotals,
  emptyCart,
  isEmptyCart,
  overrideMatches,
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
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amount) || row.amount < 0)
      throw new SaleInvalidError('payment amount');
  }
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

export type SaleResult = { sale: SyncedRow; created: boolean };

/** Sale recipe (02 §5): one Dexie transaction with its outbox ops; then the cart tab is empty. */
export async function completeSale(
  db: BikriDb,
  input: SaleInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<SaleResult> {
  const { cart, money } = input;
  if (cart.lines.length === 0) throw new SaleInvalidError('empty cart');
  let totals: CartResult = cartTotals(cart, money);
  const rows = mergeRows(input.rows);
  const s = settle(totals.total, rows);
  if (!s.valid) throw new SaleInvalidError('payments do not cover the total');
  const customerId = cart.customer_id ?? null;
  if (s.udhaar > 0 && !customerId)
    throw new SaleInvalidError('udhaar needs a customer');
  if (s.udhaar > 0) {
    const credit = await udhaarCheck(db, customerId as string, s.udhaar);
    if (
      credit.hard_blocked &&
      !overrideMatches(cart, 'udhaar.hard_limit', { udhaar: s.udhaar })
    )
      throw new SaleInvalidError('hard limit');
  }
  const device = await deviceInfo(db);
  const branch = await db.branches.get(ctx.branch_id);
  if (!device || !branch) throw new SaleInvalidError('device not set up');
  const shop = await db.shop.get('shop');
  const timeZone =
    ctx.timeZone ?? (String(shop?.timezone ?? '').trim() || 'Asia/Karachi');
  const reissue = cart.reissue ?? null;
  const backdate = cart.backdate ?? null;
  if (backdate && reissue) throw new SaleInvalidError('backdate reissue');
  const today = businessDate(now, timeZone);
  let date = today;
  let sellerId = ctx.staff_id;
  if (backdate) {
    const actor = await db.staff.get(ctx.staff_id);
    if (
      actor?.active !== 1 ||
      actor.deleted_at ||
      !can(
        String(actor.role) as 'owner' | 'manager' | 'cashier',
        String(actor.permissions_json ?? '{}'),
        'sale.backdate',
      )
    )
      throw new SaleInvalidError('backdate permission');
    if (!isBusinessDate(backdate.business_date))
      throw new SaleInvalidError('backdate date');
    if (backdate.business_date > today)
      throw new SaleInvalidError('backdate range');
    const reason = backdate.reason.trim();
    if (reason.length === 0 || reason.length > BACKDATE_REASON_MAX)
      throw new SaleInvalidError('backdate reason');
    const attributed = await db.staff.get(backdate.staff_id);
    if (attributed?.active !== 1 || attributed.deleted_at)
      throw new SaleInvalidError('backdate staff');
    date = backdate.business_date;
    sellerId = backdate.staff_id;
  }
  const voidOverride = overrideMatches(cart, 'sale.void')
    ? cart.overrides?.find((o) => o.permission === 'sale.void')
    : undefined;
  const base = {
    branch_id: ctx.branch_id,
    device_id: ctx.device_id,
    staff_id: sellerId,
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
  // Costs may have changed since the line was added (e.g. a delivery synced from another
  // till). Re-price the cart now so the below-cost decision matches the cost snapshot the
  // server will verify.
  totals = cartTotals(
    {
      ...cart,
      lines: cart.lines.map((line) => {
        const product = line.product_id
          ? products.get(line.product_id)
          : undefined;
        return product
          ? { ...line, unit_cost: unitCostOf(product, money.cost_method) }
          : line;
      }),
    },
    money,
  );

  const seller = await db.staff.get(sellerId);
  const sellerPerm = (permission: Parameters<typeof can>[2]) =>
    Boolean(
      seller &&
        can(
          seller.role as 'owner' | 'manager' | 'cashier',
          String(seller.permissions_json ?? '{}'),
          permission,
        ),
    );
  const sellerLimit = backdate
    ? Number(seller?.max_discount_bp ?? input.maxDiscountBp)
    : input.maxDiscountBp;
  if (
    totals.lines.some((line) => line.below_cost === 1) &&
    !sellerPerm('sale.below_cost') &&
    !overrideMatches(cart, 'sale.below_cost')
  )
    throw new SaleInvalidError('below-cost approval');
  if (totals.discount_share_bp > 0 && !sellerPerm('sale.discount'))
    throw new SaleInvalidError('discount permission');
  if (
    totals.discount_share_bp > sellerLimit &&
    !overrideMatches(cart, 'sale.discount')
  )
    throw new SaleInvalidError('discount override');
  if (s.udhaar > 0 && !sellerPerm('sale.udhaar'))
    throw new SaleInvalidError('udhaar permission');

  // A past sale is attributed to another staff member, so every check the Worker makes
  // against that seller has to run locally too. In particular, a recorder with
  // `catalog.edit` may authorize yesterday's price; the Worker requires a line-bound
  // `catalog.edit` override for that, not a silent old price.
  const backdatePriceAudits: { lineKey: string; price: number }[] = [];
  if (backdate) {
    if (!sellerPerm('sale.create'))
      throw new SaleInvalidError('seller cannot create sales');
    const recorder = await db.staff.get(ctx.staff_id);
    const recorderCanEdit = Boolean(
      recorder &&
        can(
          recorder.role as 'owner' | 'manager' | 'cashier',
          String(recorder.permissions_json ?? '{}'),
          'catalog.edit',
        ),
    );
    for (const line of cart.lines) {
      if (!line.product_id) continue;
      const product = products.get(line.product_id);
      if (!product || line.unit_price >= Number(product.price ?? 0)) continue;
      if (sellerPerm('catalog.edit')) continue;
      if (
        overrideMatches(cart, 'catalog.edit', {
          line: line.key,
          price: line.unit_price,
        })
      )
        continue;
      if (!recorderCanEdit) throw new SaleInvalidError('price approval');
      backdatePriceAudits.push({ lineKey: line.key, price: line.unit_price });
    }
  }

  let created = false;
  const sale = await writeAction(
    db,
    async (w) => {
      const existing = await w
        .table<SyncedRow, string>('sales')
        .get(input.saleId);
      if (existing) return existing;
      // Another tab may have added/removed a line after this pay screen opened.
      // Writing the caller's stale cart would silently drop that work.
      const live = await w.table<Cart, string>('carts').get(input.cartId);
      const signature = (value: Cart) =>
        JSON.stringify({
          customer_id: value.customer_id ?? null,
          lines: value.lines.map((line) => [
            line.key,
            line.product_id,
            line.qty_milli,
            line.unit_price,
            line.discount_type,
            line.discount_value,
          ]),
          bill_discount: value.bill_discount ?? null,
          reissue: value.reissue ?? null,
          backdate: value.backdate ?? null,
        });
      if (
        live &&
        live.updated_at >= cart.updated_at &&
        signature(live) !== signature(cart)
      )
        throw new SaleInvalidError('cart changed');
      const kv = w.table<{ key: string; value: unknown }>('kv');
      const last = (await kv.get('cart_last_sale'))?.value as
        | { cart_id?: string; at?: number }
        | undefined;
      if (
        last?.cart_id === input.cartId &&
        Number(last.at ?? 0) >= Number(cart.updated_at)
      )
        throw new SaleInvalidError('cart already paid in another tab');
      created = true;
      // Void & reissue (screens/10): the old bill's reversal is part of this same action.
      const reissuePlan = reissue
        ? await computeVoid(w, reissue.sale_id, {
            staffId: ctx.staff_id,
            override: voidOverride !== undefined,
            now,
          })
        : null;
      if (reissuePlan) {
        // One reissue writes the void and the replacement bill in one transaction. The
        // server accepts at most 200 ops per transaction; refuse before writing a tx
        // that can never leave the outbox. The estimate deliberately over-counts.
        const newBillOps =
          1 +
          cart.lines.length * 2 +
          3 + // one payment row per method (cash/card/bank)
          1 + // udhaar ledger
          (cart.overrides?.length ?? 0) +
          (backdate ? 1 : 0) +
          2; // discount/share audits
        const voidOps =
          1 +
          reissuePlan.payments.length +
          (reissuePlan.udhaar > 0 ? 1 : 0) +
          reissuePlan.productOf.size +
          2; // void + optional override audit
        if (newBillOps + voidOps > MAX_OPS_PER_TX)
          throw new SaleInvalidError('too many ops');
      }
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
      const saleLineIds = new Map<string, string>();
      for (const { line, r } of ordered) {
        if (!r) continue;
        lineNo += 1;
        const product = line.product_id
          ? products.get(line.product_id)
          : undefined;
        const currentProduct = line.product_id
          ? await w.table<MasterRow, string>('products').get(line.product_id)
          : undefined;
        const unitCost = currentProduct
          ? unitCostOf(currentProduct, money.cost_method)
          : line.unit_cost;
        const warranty = Number(product?.warranty_days ?? 0);
        const discounted = line.discount_type && line.discount_value > 0;
        const saleLineId = newId(now);
        saleLineIds.set(line.key, saleLineId);
        await w.insert('sale_lines', {
          id: saleLineId,
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
          unit_cost_snapshot: unitCost,
          below_cost: isBelowCost(r.revenue, line.qty_milli, unitCost) ? 1 : 0,
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
      for (const o of cart.overrides ?? []) {
        if (o.permission === 'sale.void') continue;
        // `bound_cart` is a large local signature used only by overrideMatches; the
        // server ignores it and the audit row has a 4,000-character column cap.
        const { bound_cart: _boundCart, ...approval } = o;
        // A price approval is bound to the cart key it was given for; store the bill's
        // line id so the Worker can link the audit row to the exact sale line.
        const boundLine =
          typeof o.bound_line === 'string'
            ? saleLineIds.get(o.bound_line)
            : undefined;
        await audit(
          'override',
          boundLine === undefined
            ? approval
            : { ...approval, bound_line: boundLine },
        );
      }
      // The recorder authorized a past price for the attributed seller. Write the same
      // line-bound audit the normal price-override path writes.
      for (const price of backdatePriceAudits) {
        const boundLine = saleLineIds.get(price.lineKey);
        if (!boundLine) continue;
        await audit('override', {
          permission: 'catalog.edit',
          approved_by: ctx.staff_id,
          approved_at: now,
          bound_line: boundLine,
          bound_price: price.price,
        });
      }
      if (totals.discount_share_bp > sellerLimit)
        await audit('discount_over_limit', {
          discount_share_bp: totals.discount_share_bp,
          limit_bp: sellerLimit,
          approved_by: overrideMatches(cart, 'sale.discount')
            ? (cart.overrides?.find((o) => o.permission === 'sale.discount')
                ?.approved_by ?? null)
            : null,
        });
      if (backdate)
        await audit('sale_backdated', {
          attributed_staff_id: sellerId,
          business_date: date,
          reason: backdate.reason.trim(),
          recorded_at: now,
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
      await kv.put({
        key: 'cart_last_sale',
        value: {
          cart_id: input.cartId,
          at: Math.max(now, Number(cart.updated_at)),
        },
      });
      await w.table<Cart, string>('carts').put(emptyCart(input.cartId, now));
      return saleRow;
    },
    { now, actor: ctx.staff_id },
  );
  if (!created) return { sale, created: false };
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
  if (target && !isEmptyCart(target)) throw new CartNotEmptyError();
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

/** Quotations (D-305, screens/21): a non-financial sales document. */
import {
  businessDate,
  type CartResult,
  formatMoney,
  formatQtyFromMilli,
  type NumberGrouping,
  newId,
  priceBundle,
} from '@bikri/core';
import type { BikriDb, Cart, CartLine, MasterRow, SyncedRow } from '@bikri/db';
import { csvCell, qtyCsv, rupeesCsv } from '../lib/csv.ts';
import { addDays, isBusinessDate } from './backdate.ts';
import {
  bundleNetPrice,
  type CartId,
  cartTotals,
  emptyCart,
  type ShopMoney,
  unitCostOf,
} from './cart.ts';
import { deviceInfo } from './localTenant.ts';
import { belowCataloguePrices } from './sale.ts';
import { WRITE_SCOPE_BASE, writeAction } from './write.ts';

export const QUOTE_PREFIX = 'QTN';
export const QUOTE_NOTE_MAX = 500;

export type QuoteErrorCode =
  | 'empty'
  | 'validity'
  | 'note'
  | 'missing'
  | 'terminal'
  | 'bundle_changed'
  | 'read_only'
  | 'changed';

export class QuoteError extends Error {
  readonly code: QuoteErrorCode;
  constructor(code: QuoteErrorCode) {
    super(code);
    this.name = 'QuoteError';
    this.code = code;
  }
}

export type QuoteStatus = 'open' | 'converted' | 'cancelled';
export type QuoteDisplayStatus = QuoteStatus | 'expired';

export function quoteStatus(
  quote: Record<string, unknown>,
  today: string,
): QuoteDisplayStatus {
  const status = String(quote.status);
  if (status === 'converted' || status === 'cancelled') return status;
  return String(quote.valid_until) < today ? 'expired' : 'open';
}

export function quoteNumber(deviceCode: string, seq: number): string {
  return `${QUOTE_PREFIX}-${deviceCode}-${seq}`;
}

export type SaveQuoteInput = {
  cartId: CartId;
  cart: Cart;
  money: ShopMoney;
  validUntil: string;
  terms: string;
  staffId: string;
  now?: number;
};

export type SaveQuoteResult = { quote: SyncedRow; created: boolean };

function quoteLineRow(
  quoteId: string,
  line: CartLine,
  result: CartResult['lines'][number] | undefined,
  lineNo: number,
  now: number,
): SyncedRow {
  const discounted = line.discount_type && line.discount_value > 0;
  const bundleBasePrice = line.bundle_base_price ?? line.bundle_price ?? 0;
  const bundleDiscount = Math.max(
    0,
    bundleBasePrice - Number(line.bundle_price ?? 0),
  );
  return {
    id: newId(now),
    quote_id: quoteId,
    line_no: lineNo,
    product_id: line.product_id,
    name_snapshot: line.name,
    sku_snapshot: line.sku,
    qty_milli: line.qty_milli,
    unit_price: line.unit_price,
    gross: result?.gross ?? 0,
    discount_type: discounted
      ? line.discount_type === 'percent'
        ? 'pct'
        : 'rs'
      : null,
    discount_value: discounted ? line.discount_value : 0,
    discount: result?.discount ?? 0,
    net: result?.net ?? 0,
    note: (line.note ?? '').slice(0, 60),
    unit_cost_snapshot: Number(line.unit_cost ?? 0),
    bundle_id: line.bundle_id ?? null,
    bundle_group: line.bundle_group ?? null,
    bundle_name: line.bundle_name ?? null,
    bundle_qty: line.bundle_qty ?? null,
    bundle_price: line.bundle_id ? Number(bundleBasePrice) : null,
    bundle_component_qty_milli: line.bundle_component_qty_milli ?? null,
    bundle_discount: line.bundle_id ? Number(bundleDiscount) : 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 0,
    updated_by: null,
  };
}

/** Save (create or update) the quote represented by one cart. */
export async function saveQuote(
  db: BikriDb,
  input: SaveQuoteInput,
): Promise<SaveQuoteResult> {
  const now = input.now ?? Date.now();
  const { cart, money } = input;
  if (cart.lines.length === 0) throw new QuoteError('empty');
  if (cart.lines.length > 60) throw new QuoteError('empty');
  const terms = input.terms.trim();
  if (terms.length > QUOTE_NOTE_MAX) throw new QuoteError('note');
  if (!isBusinessDate(input.validUntil)) throw new QuoteError('validity');
  const device = await deviceInfo(db);
  if (!device) throw new QuoteError('missing');
  const shop = await db.shop.get('shop');
  const timeZone = String(shop?.timezone ?? '').trim() || 'Asia/Karachi';
  const today = businessDate(now, timeZone);
  const existingId = cart.quote?.mode === 'edit' ? cart.quote.quote_id : null;
  const existing = existingId ? await db.quotations.get(existingId) : null;
  if (existingId && !existing) throw new QuoteError('missing');
  if (existing && String(existing.status) !== 'open')
    throw new QuoteError('terminal');
  const businessDateValue = existing ? String(existing.business_date) : today;
  // An edit keeps the document's original business date, so the +365-day horizon
  // must be measured from that date (POS-M2), not from today.
  if (input.validUntil < businessDateValue) throw new QuoteError('validity');
  if (input.validUntil > addDays(businessDateValue, 365))
    throw new QuoteError('validity');

  const totals = cartTotals(cart, money);
  const customer = cart.customer_id
    ? await db.customers.get(cart.customer_id)
    : undefined;
  const quoteId = existingId ?? newId(now);

  let created = false;
  const quote = await writeAction(
    db,
    async (w) => {
      const live = await w.table<Cart, string>('carts').get(input.cartId);
      if (
        live &&
        live.updated_at >= cart.updated_at &&
        JSON.stringify(live) !== JSON.stringify(cart)
      )
        throw new QuoteError('changed');
      if (existingId) {
        const current = await w
          .table<SyncedRow, string>('quotations')
          .get(existingId);
        if (!current || String(current.status) !== 'open')
          throw new QuoteError('terminal');
      }
      const kv = w.table<{ key: string; value: unknown }>('kv');
      const allExistingLines = existing
        ? await w
            .table<SyncedRow, string>('quotation_lines')
            .where('quote_id')
            .equals(quoteId)
            .toArray()
        : [];
      const existingLines = allExistingLines.filter(
        (line) => line.deleted_at === null || line.deleted_at === undefined,
      );
      const existingById = new Map(
        existingLines.map((line) => [String(line.id), line]),
      );
      const ordered = cart.lines
        .map((line, index) => ({ line, result: totals.lines[index] }))
        .reverse();
      let nextLineNo =
        allExistingLines.reduce(
          (max, line) => Math.max(max, Number(line.line_no ?? 0)),
          0,
        ) + 1;
      const kept = new Set<string>();
      const lineRows: SyncedRow[] = [];
      const lineIdByKey = new Map<string, string>();
      for (const { line, result } of ordered) {
        const existingLine = existingById.get(line.key);
        if (existingLine) {
          kept.add(String(existingLine.id));
          lineIdByKey.set(line.key, String(existingLine.id));
          const row = quoteLineRow(
            quoteId,
            line,
            result,
            Number(existingLine.line_no),
            now,
          );
          const patch = { ...row, id: existingLine.id };
          delete (patch as { created_at?: number }).created_at;
          delete (patch as { rev?: number }).rev;
          await w.update('quotation_lines', String(existingLine.id), patch);
          continue;
        }
        const row = quoteLineRow(quoteId, line, result, nextLineNo, now);
        nextLineNo += 1;
        lineIdByKey.set(line.key, row.id);
        await w.create('quotation_lines', row);
        lineRows.push(row);
      }
      for (const line of existingLines) {
        if (!kept.has(String(line.id)))
          await w.remove('quotation_lines', String(line.id));
      }

      let seq = Number(existing?.quote_seq ?? 0);
      let quoteNo = String(existing?.quote_no ?? '');
      if (!existing) {
        seq = Number((await kv.get('quote_seq'))?.value ?? 0) + 1;
        await kv.put({ key: 'quote_seq', value: seq });
        quoteNo = quoteNumber(device.code, seq);
      }
      const bill =
        cart.bill_discount && cart.bill_discount.value > 0
          ? cart.bill_discount
          : null;
      const row: SyncedRow = {
        id: quoteId,
        quote_no: quoteNo,
        quote_seq: seq,
        branch_id: existing ? String(existing.branch_id) : device.branch_id,
        device_id: existing ? String(existing.device_id) : device.id,
        staff_id: existing ? String(existing.staff_id) : input.staffId,
        customer_id: cart.customer_id ?? null,
        customer_name: customer ? String(customer.name) : '',
        customer_phone: customer ? String(customer.phone ?? '') : '',
        business_date: businessDateValue,
        valid_until: input.validUntil,
        status: 'open',
        line_count: ordered.length,
        items_qty_milli: ordered.reduce(
          (sum, { line }) => sum + line.qty_milli,
          0,
        ),
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
        round_total_to: money.round_total_to,
        rounding: totals.rounding,
        total: totals.total,
        note: terms,
        converted_sale_id: null,
        converted_at: null,
        cancelled_reason: '',
        cancelled_at: null,
        created_at: existing ? Number(existing.created_at) : now,
        updated_at: now,
        deleted_at: null,
        rev: existing ? Number(existing.rev) : 0,
        updated_by: input.staffId,
      };
      if (existing) {
        const patch = { ...row };
        delete (patch as { created_at?: number }).created_at;
        delete (patch as { rev?: number }).rev;
        await w.update('quotations', quoteId, patch, { force: true });
      } else {
        created = true;
        await w.create('quotations', row);
      }
      await w.insert('audit_log', {
        id: newId(now),
        action: existing ? 'quote_change' : 'quote_create',
        entity: 'quotations',
        entity_id: quoteId,
        before_json: existing
          ? JSON.stringify({
              status: existing.status,
              total: Number(existing.total),
            })
          : null,
        after_json: JSON.stringify({
          quote_no: quoteNo,
          customer: row.customer_name,
          line_count: row.line_count,
          total: row.total,
        }),
        device_id: device.id,
        staff_id: input.staffId,
        created_at: now,
      });
      // Approvals live on the quote document, not on a sale that does not exist yet.
      // The Worker validates these `override` audit rows with the same rules as a sale.
      for (const override of cart.overrides ?? []) {
        if (override.permission === 'sale.void') continue;
        const { bound_cart: _boundCart, ...approval } = override;
        const boundLine =
          typeof approval.bound_line === 'string'
            ? lineIdByKey.get(approval.bound_line)
            : undefined;
        await w.insert('audit_log', {
          id: newId(now),
          action: 'override',
          entity: 'quotations',
          entity_id: quoteId,
          before_json: null,
          after_json: JSON.stringify({
            ...approval,
            ...(boundLine === undefined ? {} : { bound_line: boundLine }),
          }),
          device_id: device.id,
          staff_id: input.staffId,
          created_at: now,
        });
      }
      await w.table<Cart, string>('carts').put(emptyCart(input.cartId, now));
      return row;
    },
    {
      now,
      actor: input.staffId,
      tables: [
        ...WRITE_SCOPE_BASE,
        'carts',
        'quotations',
        'quotation_lines',
        'audit_log',
      ],
      changedTables: ['quotations', 'quotation_lines', 'audit_log', 'carts'],
    },
  );
  return { quote, created };
}

/** Cancel an open quote. No stock or money is reversed because none moved. */
export async function cancelQuote(
  db: BikriDb,
  input: { quoteId: string; reason: string; staffId: string; now?: number },
): Promise<SyncedRow> {
  const now = input.now ?? Date.now();
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 120) throw new QuoteError('note');
  const quote = await db.quotations.get(input.quoteId);
  if (!quote) throw new QuoteError('missing');
  if (String(quote.status) !== 'open') throw new QuoteError('terminal');
  const device = await deviceInfo(db);
  if (!device) throw new QuoteError('missing');
  return writeAction(
    db,
    async (w) => {
      const current = await w
        .table<SyncedRow, string>('quotations')
        .get(input.quoteId);
      if (!current) throw new QuoteError('missing');
      if (String(current.status) !== 'open') throw new QuoteError('terminal');
      await w.update('quotations', input.quoteId, {
        status: 'cancelled',
        cancelled_reason: reason,
        cancelled_at: now,
        converted_sale_id: null,
        converted_at: null,
      });
      await w.insert('audit_log', {
        id: newId(now),
        action: 'quote_cancel',
        entity: 'quotations',
        entity_id: input.quoteId,
        before_json: JSON.stringify({ status: current.status }),
        after_json: JSON.stringify({ status: 'cancelled', reason }),
        device_id: device.id,
        staff_id: input.staffId,
        created_at: now,
      });
      return {
        ...current,
        status: 'cancelled',
        cancelled_reason: reason,
        cancelled_at: now,
      };
    },
    {
      now,
      actor: input.staffId,
      tables: [...WRITE_SCOPE_BASE, 'quotations', 'audit_log'],
      changedTables: ['quotations', 'audit_log'],
    },
  );
}

/** Load a quote into a cart for editing or conversion. */
export async function startQuoteCart(
  db: BikriDb,
  input: {
    quoteId: string;
    cartId: CartId;
    mode: 'edit' | 'convert' | 'duplicate';
    /** Expired conversions either use today's catalogue prices or the saved quote. */
    pricing?: 'quoted' | 'today';
    /** Who approved using the quoted prices after expiry, if anyone. */
    approvedBy?: string | null;
    staffId?: string | null;
    now?: number;
  },
): Promise<Cart> {
  const now = input.now ?? Date.now();
  const quote = await db.quotations.get(input.quoteId);
  if (!quote) throw new QuoteError('missing');
  const device = await deviceInfo(db);
  if (!device) throw new QuoteError('missing');
  const status = String(quote.status);
  if (status === 'cancelled' && input.mode !== 'duplicate')
    throw new QuoteError('terminal');
  if (input.mode === 'edit' && status !== 'open')
    throw new QuoteError('terminal');
  if (input.mode === 'convert' && status === 'converted')
    throw new QuoteError('terminal');
  const lines = await db.quotation_lines
    .where('quote_id')
    .equals(input.quoteId)
    .sortBy('line_no');
  const products = new Map(
    (
      await db.products.bulkGet([
        ...new Set(
          lines
            .flatMap((line) => [line.product_id, line.bundle_id])
            .filter((id): id is string => typeof id === 'string'),
        ),
      ])
    )
      .filter((row): row is MasterRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const shop = await db.shop.get('shop');
  const timeZone = String(shop?.timezone ?? '').trim() || 'Asia/Karachi';
  const today = businessDate(now, timeZone);
  const money = {
    tax_rate_bp: Number(quote.tax_rate_bp ?? 0),
    tax_mode:
      Number(quote.tax_inclusive ?? 0) === 1
        ? ('inclusive' as const)
        : ('exclusive' as const),
    tax_label: String(shop?.tax_label ?? 'Sales tax'),
    round_total_to: Number(quote.round_total_to ?? 1),
    cost_method:
      String(shop?.cost_method ?? 'avg') === 'last'
        ? ('last' as const)
        : ('avg' as const),
    show_cost_on_till: Number(shop?.show_cost_on_till ?? 0) === 1,
  };
  const live = lines.filter(
    (line) => line.deleted_at === null || line.deleted_at === undefined,
  );
  let customerId = quote.customer_id ? String(quote.customer_id) : null;
  if (input.mode === 'convert') {
    if (customerId) {
      const customer = await db.customers.get(customerId);
      if (!customer || customer.deleted_at) customerId = null;
    }
    // A bundle recipe that changed or disappeared after the quote was saved cannot be
    // converted with the old component snapshot: the Worker would reject the paid sale
    // (POS-M1). Block the conversion with a clear error instead of committing locally.
    const groups = new Map<string, SyncedRow[]>();
    for (const line of live) {
      if (!line.bundle_group) continue;
      const group = String(line.bundle_group);
      groups.set(group, [...(groups.get(group) ?? []), line]);
    }
    for (const groupLines of groups.values()) {
      const first = groupLines[0];
      const bundleId = first?.bundle_id ? String(first.bundle_id) : '';
      if (!bundleId) throw new QuoteError('bundle_changed');
      const bundle = await db.products.get(bundleId);
      if (!bundle || bundle.deleted_at) throw new QuoteError('bundle_changed');
      const recipe = (
        await db.bundle_items.where('bundle_id').equals(bundleId).toArray()
      ).filter(
        (item) => item.deleted_at === null || item.deleted_at === undefined,
      );
      const expected = new Map(
        recipe.map((item) => [
          String(item.component_product_id),
          Number(item.qty_milli ?? 0),
        ]),
      );
      const actual = new Map(
        groupLines.map((line) => [
          String(line.product_id ?? ''),
          Number(line.bundle_component_qty_milli ?? 0),
        ]),
      );
      if (
        expected.size !== actual.size ||
        [...expected].some(([productId, qty]) => actual.get(productId) !== qty)
      )
        throw new QuoteError('bundle_changed');
    }
  }
  // Today's-price conversion re-prices every simple line and every bundle group from
  // the current catalogue. Bundles keep their group discount but follow the current
  // shelf price and recipe, exactly like a fresh Sell cart (D-305).
  const todayPrices =
    input.pricing === 'today'
      ? await repriceLines(db, live, money.cost_method)
      : null;
  const cartLines: CartLine[] = live
    .map((line) => {
      const product = line.product_id
        ? products.get(String(line.product_id))
        : undefined;
      const priced = todayPrices?.lines.get(String(line.id));
      const bundlePrice = priced?.bundleBase ?? Number(line.bundle_price ?? 0);
      const bundleDiscount = priced
        ? Math.max(0, bundlePrice - priced.bundleNet)
        : Number(line.bundle_discount ?? 0);
      return {
        key: String(line.id),
        product_id: line.product_id ? String(line.product_id) : null,
        name: String(line.name_snapshot),
        sku: String(line.sku_snapshot ?? ''),
        qty_milli: Number(line.qty_milli),
        unit_price: priced?.unitPrice ?? Number(line.unit_price),
        ...(priced && line.bundle_id
          ? priced.discount > 0
            ? { discount_type: 'amount' as const }
            : {}
          : line.discount_type === 'pct'
            ? { discount_type: 'percent' as const }
            : line.discount_type === 'rs'
              ? { discount_type: 'amount' as const }
              : {}),
        discount_value:
          priced && line.bundle_id
            ? priced.discount
            : Number(line.discount_value ?? 0),
        unit_cost: product
          ? unitCostOf(product, money.cost_method)
          : Number(line.unit_cost_snapshot ?? 0),
        ...(product?.image_key ? { image_key: String(product.image_key) } : {}),
        list_price: product ? Number(product.price) : Number(line.unit_price),
        ...(line.note ? { note: String(line.note) } : {}),
        track_stock: (product?.track_stock === 1 ? 1 : 0) as 0 | 1,
        unit: String(product?.unit ?? 'pc'),
        ...(line.bundle_id
          ? {
              bundle_id: String(line.bundle_id),
              bundle_group: String(line.bundle_group ?? ''),
              bundle_name: String(line.bundle_name ?? ''),
              bundle_qty: Number(line.bundle_qty ?? 0),
              bundle_price: priced?.bundleNet ?? bundlePrice - bundleDiscount,
              bundle_list_price: bundlePrice,
              bundle_base_price: bundlePrice,
              bundle_discount_type:
                bundleDiscount > 0 ? ('amount' as const) : undefined,
              bundle_discount_value: bundleDiscount,
              bundle_component_qty_milli: Number(
                line.bundle_component_qty_milli ?? 0,
              ),
            }
          : {}),
      };
    })
    .reverse();
  const cart: Cart = {
    ...emptyCart(input.cartId, now),
    customer_id: customerId,
    lines: cartLines,
    bill_discount:
      quote.bill_discount_type === 'pct' &&
      Number(quote.bill_discount_value ?? 0) > 0
        ? { type: 'percent', value: Number(quote.bill_discount_value) }
        : quote.bill_discount_type === 'rs' &&
            Number(quote.bill_discount_value ?? 0) > 0
          ? { type: 'amount', value: Number(quote.bill_discount_value) }
          : null,
    quote:
      input.mode === 'duplicate'
        ? {
            quote_id: null,
            quote_no: null,
            valid_until: addDays(today, 7),
            terms: String(quote.note ?? ''),
            mode: 'new',
          }
        : {
            quote_id: input.quoteId,
            quote_no: String(quote.quote_no),
            valid_until: String(quote.valid_until),
            terms: String(quote.note ?? ''),
            mode: input.mode,
          },
    updated_at: now,
  };
  const expired = status === 'open' && String(quote.valid_until) < today;
  if (
    input.mode === 'convert' &&
    input.pricing === 'quoted' &&
    expired &&
    input.approvedBy &&
    input.staffId
  ) {
    // The manager approval covers each quoted price that is below today's catalogue, so
    // the later sale checks accept the same lines instead of asking for a second
    // approval at payment.
    const overruns = belowCataloguePrices(cart, products);
    if (overruns.length > 0) {
      cart.overrides = overruns.map((overrun) => ({
        permission: 'catalog.edit',
        approved_by: input.approvedBy as string,
        approved_at: now,
        bound_line: overrun.key,
        bound_price: overrun.price,
      }));
    }
    await writeAction(
      db,
      async (w) => {
        await w.insert('audit_log', {
          id: newId(now),
          action: 'quote_expired_price_used',
          entity: 'quotations',
          entity_id: input.quoteId,
          before_json: null,
          after_json: JSON.stringify({
            quote_no: String(quote.quote_no),
            approved_by: input.approvedBy,
          }),
          device_id: device.id,
          staff_id: input.staffId,
          created_at: now,
        });
        await w.table<Cart, string>('carts').put(cart);
      },
      {
        now,
        actor: input.staffId,
        tables: [...WRITE_SCOPE_BASE, 'carts', 'audit_log'],
        changedTables: ['carts', 'audit_log'],
      },
    );
    return cart;
  }
  await db.carts.put(cart);
  return cart;
}

type RepricedLine = {
  unitPrice: number;
  discount: number;
  bundleBase: number;
  bundleNet: number;
};

/** Current-catalogue prices for an expired quote conversion, keyed by quote line id. */
async function repriceLines(
  db: BikriDb,
  lines: readonly SyncedRow[],
  costMethod: 'avg' | 'last',
): Promise<{ lines: Map<string, RepricedLine> }> {
  const productIds = [
    ...new Set(
      lines
        .map((line) => line.product_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const products = new Map(
    (await db.products.bulkGet(productIds))
      .filter((row): row is MasterRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const result = new Map<string, RepricedLine>();
  for (const line of lines) {
    if (line.bundle_group) continue;
    const product = line.product_id
      ? products.get(String(line.product_id))
      : undefined;
    if (!product) continue;
    result.set(String(line.id), {
      unitPrice: Number(product.price),
      discount: 0,
      bundleBase: 0,
      bundleNet: 0,
    });
  }
  const groups = new Map<string, SyncedRow[]>();
  for (const line of lines) {
    if (!line.bundle_group) continue;
    const group = String(line.bundle_group);
    groups.set(group, [...(groups.get(group) ?? []), line]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first?.bundle_id) continue;
    const bundle = await db.products.get(String(first.bundle_id));
    if (!bundle || bundle.deleted_at) continue;
    const recipe = (
      await db.bundle_items
        .where('bundle_id')
        .equals(String(first.bundle_id))
        .toArray()
    ).filter(
      (item) => item.deleted_at === null || item.deleted_at === undefined,
    );
    const recipeProducts = new Map(
      (
        await db.products.bulkGet(
          recipe.map((item) => String(item.component_product_id)),
        )
      )
        .filter((row): row is MasterRow => row !== undefined)
        .map((row) => [row.id, row]),
    );
    if (recipe.length === 0 || recipe.length !== group.length) continue;
    const base = Number(bundle.price);
    const discount = Number(first.bundle_discount ?? 0);
    const net = bundleNetPrice(base, 'amount', discount);
    const components = group.map((line) => {
      const product = recipeProducts.get(String(line.product_id));
      const qty = Number(line.bundle_component_qty_milli ?? 0);
      return {
        qty_milli: qty,
        unit_cost: product
          ? unitCostOf(product, costMethod)
          : Number(line.unit_cost_snapshot ?? 0),
        unit_price: product ? Number(product.price) : Number(line.unit_price),
      };
    });
    try {
      const priced = priceBundle({
        bundle_price: net,
        bundle_qty: Math.max(1, Number(first.bundle_qty ?? 1)),
        components,
      });
      group.forEach((line, index) => {
        const pricedLine = priced.lines[index];
        if (!pricedLine) return;
        result.set(String(line.id), {
          unitPrice: pricedLine.unit_price,
          discount: pricedLine.discount,
          bundleBase: base,
          bundleNet: net,
        });
      });
    } catch {
      // A malformed or emptied recipe keeps the saved quote lines.
    }
  }
  return { lines: result };
}

/** Start a new quote in a cart (number is assigned when the quote is saved). */
export async function startNewQuote(
  db: BikriDb,
  cartId: CartId,
  now = Date.now(),
): Promise<Cart> {
  const existing = await db.carts.get(cartId);
  if (existing && (existing.lines.length > 0 || existing.quote))
    throw new QuoteError('changed');
  const shop = await db.shop.get('shop');
  const timeZone = String(shop?.timezone ?? '').trim() || 'Asia/Karachi';
  const today = businessDate(now, timeZone);
  const cart: Cart = {
    ...(existing ?? emptyCart(cartId, now)),
    id: cartId,
    quote: {
      quote_id: null,
      quote_no: null,
      valid_until: addDays(today, 7),
      terms: '',
      mode: 'new',
    },
    updated_at: now,
  };
  await db.carts.put(cart);
  return cart;
}

/** Queue a quotation print job; the quote is already saved. */
export async function queueQuotePrint(
  db: BikriDb,
  quoteId: string,
  options: { reprint?: boolean; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const id = newId(now);
  await db.print_jobs.put({
    id,
    quotation_id: quoteId,
    kind: 'quotation',
    status: 'queued',
    reprint: options.reprint === true,
    created_at: now,
  });
  return id;
}

/** Plain-text quote for WhatsApp/OS share. Prices are already snapshot on the quote. */
export function quoteShareText(
  quote: SyncedRow,
  lines: readonly SyncedRow[],
  shopName: string,
  numberGrouping: NumberGrouping = 'intl',
): string {
  const format = (paisa: number): string => formatMoney(paisa, numberGrouping);
  const qty = (milli: number): string => formatQtyFromMilli(milli, '');
  const blocks: string[] = [];
  const seenGroups = new Set<string>();
  for (const line of lines) {
    if (line.deleted_at !== null && line.deleted_at !== undefined) continue;
    const group = line.bundle_group == null ? null : String(line.bundle_group);
    if (group === null) {
      blocks.push(
        `${String(line.name_snapshot)} × ${qty(Number(line.qty_milli))}  ${format(Number(line.net))}`,
      );
      continue;
    }
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    const groupLines = lines.filter(
      (candidate) =>
        (candidate.deleted_at === null || candidate.deleted_at === undefined) &&
        candidate.bundle_group != null &&
        String(candidate.bundle_group) === group,
    );
    const first = groupLines[0] ?? line;
    const total = groupLines.reduce(
      (sum, component) => sum + Number(component.net),
      0,
    );
    blocks.push(
      `${String(first.bundle_name ?? first.name_snapshot)} × ${qty(
        Number(first.bundle_qty ?? 0) * 1000,
      )}  ${format(total)}`,
    );
    for (const component of groupLines)
      blocks.push(
        `  ${String(component.name_snapshot)} × ${qty(Number(component.qty_milli))}`,
      );
  }
  const rows = [
    shopName,
    `QUOTATION ${String(quote.quote_no)}`,
    `Valid until ${String(quote.valid_until)}`,
    ...(quote.customer_name
      ? [`Customer: ${String(quote.customer_name)}`]
      : []),
    ...blocks,
    `Total ${format(Number(quote.total))}`,
    ...(String(quote.note ?? '').trim()
      ? [`Terms: ${String(quote.note).trim()}`]
      : []),
    'This is a quotation, not a tax invoice.',
  ];
  return rows.join('\n');
}

/** CSV of the current quotation list (REQ-B02, screens/21). */
export function quotesCsv(
  rows: readonly Record<string, unknown>[],
  staffNames: ReadonlyMap<string, string>,
  deviceNames: ReadonlyMap<string, string>,
  today = businessDate(Date.now(), 'Asia/Karachi'),
): string {
  const header = [
    'quote_no',
    'date',
    'valid_until',
    'customer',
    'phone',
    'items',
    'subtotal',
    'discounts',
    'tax',
    'total',
    'status',
    'staff',
    'device',
  ];
  return [header.join(',')]
    .concat(
      rows.map((quote) =>
        [
          String(quote.quote_no),
          String(quote.business_date),
          String(quote.valid_until),
          String(quote.customer_name ?? ''),
          String(quote.customer_phone ?? ''),
          qtyCsv(Number(quote.items_qty_milli ?? 0)),
          rupeesCsv(Number(quote.subtotal ?? 0)),
          rupeesCsv(
            Number(quote.item_discount_total ?? 0) +
              Number(quote.bill_discount ?? 0),
          ),
          rupeesCsv(Number(quote.tax ?? 0)),
          rupeesCsv(Number(quote.total ?? 0)),
          quoteStatus(quote, today),
          staffNames.get(String(quote.staff_id)) ?? '',
          deviceNames.get(String(quote.device_id)) ?? '',
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n');
}

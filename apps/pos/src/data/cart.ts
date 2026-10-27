import {
  type CartResult,
  type CostMethod,
  computeCart,
  newId,
  type TaxMode,
} from '@bikri/core';
import type {
  BikriDb,
  Cart,
  CartLine,
  CartOverride,
  HeldBill,
  MasterRow,
} from '@bikri/db';

/** Open carts on one till (screens/05: Customer 1/2/3). */
export const CART_IDS = ['c1', 'c2', 'c3'] as const;
export type CartId = (typeof CART_IDS)[number];
/** One bill's sync ops stay ≤ 200 (03 §3). */
export const MAX_CART_LINES = 60;
export const HELD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTE_MAX = 60;

export class CartFullError extends Error {
  constructor() {
    super(`A bill can have ${MAX_CART_LINES} lines`);
    this.name = 'CartFullError';
  }
}

export class CartNotEmptyError extends Error {
  constructor() {
    super('The target cart is not empty');
    this.name = 'CartNotEmptyError';
  }
}

export type ShopMoney = {
  tax_rate_bp: number;
  tax_mode: TaxMode;
  round_total_to: number;
  cost_method: CostMethod;
  show_cost_on_till: boolean;
  tax_label: string;
};

export function shopMoney(shop: MasterRow | null | undefined): ShopMoney {
  return {
    tax_rate_bp: Number(shop?.tax_rate_bp ?? 0),
    tax_mode: shop?.tax_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    round_total_to: Number(shop?.round_total_to ?? 100),
    cost_method: shop?.cost_method === 'last' ? 'last' : 'avg',
    show_cost_on_till: Number(shop?.show_cost_on_till ?? 0) === 1,
    tax_label: String(shop?.tax_label ?? 'Sales tax'),
  };
}

export function emptyCart(id: CartId, now = Date.now()): Cart {
  return {
    id,
    customer_id: null,
    lines: [],
    bill_discount: null,
    note: '',
    updated_at: now,
  };
}

export function isEmptyCart(cart: Cart): boolean {
  return cart.lines.length === 0 && !cart.customer_id && !cart.bill_discount;
}

export async function loadCarts(db: BikriDb): Promise<Record<CartId, Cart>> {
  const rows = await db.carts.bulkGet([...CART_IDS]);
  return {
    c1: rows[0] ?? emptyCart('c1', 0),
    c2: rows[1] ?? emptyCart('c2', 0),
    c3: rows[2] ?? emptyCart('c3', 0),
  };
}

export async function saveCart(
  db: BikriDb,
  cart: Cart,
  now = Date.now(),
): Promise<void> {
  await db.carts.put({ ...cart, updated_at: now });
}

function unitCostOf(product: MasterRow, method: CostMethod): number {
  const avg = Number(product.avg_cost ?? 0);
  const last = Number(product.last_cost ?? 0);
  return method === 'last' ? last || avg : avg || last;
}

/** Adds `qtyMilli` of a product; merges into its line unless that line has a note or a price override. */
export function addProduct(
  cart: Cart,
  product: MasterRow,
  qtyMilli: number,
  method: CostMethod,
): Cart {
  const price = Number(product.price ?? 0);
  const index = cart.lines.findIndex(
    (l) =>
      l.product_id === product.id &&
      !l.note &&
      l.unit_price === (l.list_price ?? l.unit_price) &&
      l.unit_price === price,
  );
  if (index >= 0) {
    const lines = cart.lines.slice();
    const line = lines[index] as CartLine;
    lines[index] = { ...line, qty_milli: line.qty_milli + qtyMilli };
    return { ...cart, lines };
  }
  if (cart.lines.length >= MAX_CART_LINES) throw new CartFullError();
  const line: CartLine = {
    key: newId(),
    product_id: product.id,
    name: String(product.name_en ?? ''),
    sku: String(product.sku ?? ''),
    qty_milli: qtyMilli,
    unit_price: price,
    list_price: price,
    discount_value: 0,
    unit_cost: unitCostOf(product, method),
    track_stock: product.track_stock === 1 ? 1 : 0,
    unit: String(product.unit ?? 'pc'),
    ...(product.image_key ? { image_key: String(product.image_key) } : {}),
  };
  return { ...cart, lines: [line, ...cart.lines] };
}

/** Quick sale: no product, no stock movement, cost 0 (screens/05). */
export function addQuickSale(
  cart: Cart,
  input: { name: string; price: number; qtyMilli: number },
): Cart {
  if (cart.lines.length >= MAX_CART_LINES) throw new CartFullError();
  const line: CartLine = {
    key: newId(),
    product_id: null,
    name: input.name.trim() || 'Item',
    sku: '',
    qty_milli: input.qtyMilli,
    unit_price: input.price,
    list_price: input.price,
    discount_value: 0,
    unit_cost: 0,
    track_stock: 0,
    unit: 'pc',
  };
  return { ...cart, lines: [line, ...cart.lines] };
}

/** Changes one line; quantity 0 removes it. */
export function updateLine(
  cart: Cart,
  key: string,
  patch: Partial<CartLine>,
): Cart {
  const lines: CartLine[] = [];
  for (const line of cart.lines) {
    if (line.key !== key) {
      lines.push(line);
      continue;
    }
    const next = { ...line, ...patch };
    if (next.note !== undefined) next.note = next.note.slice(0, NOTE_MAX);
    if (next.qty_milli > 0) lines.push(next);
  }
  return { ...cart, lines };
}

export function removeLine(cart: Cart, key: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.key !== key) };
}

export function addOverride(cart: Cart, override: CartOverride): Cart {
  const rest = (cart.overrides ?? []).filter(
    (o) => o.permission !== override.permission,
  );
  return { ...cart, overrides: [...rest, override] };
}

export function hasOverride(cart: Cart, permission: string): boolean {
  return (cart.overrides ?? []).some((o) => o.permission === permission);
}

/** Bill totals per 07 §3 (cart discounts use `amount`/`percent`; money rules use `rs`/`pct`). */
export function cartTotals(cart: Cart, money: ShopMoney): CartResult {
  return computeCart({
    lines: cart.lines.map((l) => ({
      qty_milli: l.qty_milli,
      unit_price: l.unit_price,
      unit_cost: l.unit_cost,
      ...(l.discount_type && l.discount_value > 0
        ? {
            discount_type:
              l.discount_type === 'percent'
                ? ('pct' as const)
                : ('rs' as const),
            discount_value: l.discount_value,
          }
        : {}),
    })),
    bill_discount:
      cart.bill_discount && cart.bill_discount.value > 0
        ? {
            type: cart.bill_discount.type === 'percent' ? 'pct' : 'rs',
            value: cart.bill_discount.value,
          }
        : null,
    tax_rate_bp: money.tax_rate_bp,
    tax_mode: money.tax_mode,
    round_total_to: money.round_total_to,
  });
}

/** Line gross (qty × price), the cap for a line discount in rupees. */
export function lineGross(line: CartLine): number {
  return Math.round((line.qty_milli * line.unit_price) / 1000);
}

/** What Take payment needs before it opens (07 §3.1–§3.2). */
export function paymentChecks(
  cart: Cart,
  totals: CartResult,
  staff: { maxDiscountBp: number; canBelowCost: boolean; canDiscount: boolean },
): { belowCost: boolean; discount: boolean } {
  const anyBelow = totals.lines.some((l) => l.below_cost === 1);
  const discounted = totals.item_discount_total + totals.bill_discount > 0;
  const overLimit =
    discounted &&
    (!staff.canDiscount || totals.discount_share_bp > staff.maxDiscountBp);
  return {
    belowCost:
      anyBelow && !staff.canBelowCost && !hasOverride(cart, 'sale.below_cost'),
    discount: overLimit && !hasOverride(cart, 'sale.discount'),
  };
}

/** A non-deleted product whose barcode (or SKU) is `code`. */
export async function findByCode(
  db: BikriDb,
  code: string,
): Promise<MasterRow | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const barcodes = await db.product_barcodes
    .where('barcode')
    .equals(trimmed)
    .toArray();
  for (const b of barcodes) {
    if (b.deleted_at) continue;
    const product = await db.products.get(String(b.product_id));
    if (product && !product.deleted_at) return product;
  }
  const bySku = await db.products.where('sku').equals(trimmed).toArray();
  return bySku.find((p) => !p.deleted_at) ?? null;
}

/** `3*` in the search sets the next add's quantity (screens/05). */
export function parseQtyPrefix(
  query: string,
): { qtyMilli: number; rest: string } | null {
  const match = /^\s*(\d+(?:\.\d{1,3})?)\s*\*\s*(.*)$/u.exec(query);
  if (!match) return null;
  const qtyMilli = Math.round(Number(match[1]) * 1000);
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) return null;
  return { qtyMilli, rest: match[2] ?? '' };
}

/** Parks a cart in held_bills and empties it. */
export async function holdCart(
  db: BikriDb,
  cart: Cart,
  opts: { label: string; staffId: string; now?: number },
): Promise<HeldBill> {
  const now = opts.now ?? Date.now();
  const { id: cartId, ...rest } = cart;
  const held: HeldBill = {
    ...rest,
    id: newId(),
    held_at: now,
    held_by: opts.staffId,
    label: opts.label.trim(),
    created_at: now,
    updated_at: now,
  };
  await db.transaction('rw', db.held_bills, db.carts, async () => {
    await db.held_bills.add(held);
    await db.carts.put(emptyCart(cartId, now));
  });
  return held;
}

/** Puts a held bill back into an empty cart. */
export async function resumeHeld(
  db: BikriDb,
  heldId: string,
  cartId: CartId,
  now = Date.now(),
): Promise<Cart> {
  return db.transaction('rw', db.held_bills, db.carts, async () => {
    const held = await db.held_bills.get(heldId);
    if (!held) throw new Error('Held bill not found');
    const current = await db.carts.get(cartId);
    if (current && !isEmptyCart(current)) throw new CartNotEmptyError();
    const {
      held_at: _a,
      held_by: _b,
      label: _c,
      created_at: _d,
      id: _e,
      ...rest
    } = held;
    const cart: Cart = { ...rest, id: cartId, updated_at: now };
    await db.carts.put(cart);
    await db.held_bills.delete(heldId);
    return cart;
  });
}

export async function deleteHeld(db: BikriDb, heldId: string): Promise<void> {
  await db.held_bills.delete(heldId);
}

/** Held bills newest first; ones older than 7 days are dropped (screens/05). */
export async function listHeld(
  db: BikriDb,
  now = Date.now(),
): Promise<HeldBill[]> {
  const all = await db.held_bills.orderBy('created_at').reverse().toArray();
  const expired = all.filter((h) => now - h.held_at > HELD_EXPIRY_MS);
  if (expired.length > 0)
    await db.held_bills.bulkDelete(expired.map((h) => h.id));
  return all.filter((h) => now - h.held_at <= HELD_EXPIRY_MS);
}

/** Held bills older than 6 days (Home warns a day before they go). */
export async function heldExpiringCount(
  db: BikriDb,
  now = Date.now(),
): Promise<number> {
  const all = await db.held_bills.toArray();
  return all.filter(
    (h) => now - h.held_at > HELD_EXPIRY_MS - 24 * 60 * 60 * 1000,
  ).length;
}

/** Owners, and staff with the permission, who can approve an override with their PIN. */
export function approversFor(
  staff: readonly MasterRow[],
  allowed: (s: MasterRow) => boolean,
): MasterRow[] {
  return staff.filter(
    (s) =>
      s.active === 1 &&
      !s.deleted_at &&
      String(s.pin_hash ?? '') !== '' &&
      allowed(s),
  );
}

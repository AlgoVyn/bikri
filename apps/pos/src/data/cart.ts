import {
  type CartResult,
  type CostMethod,
  computeCart,
  MAX_LINES_PER_DOCUMENT,
  mulDivRound,
  newId,
  priceBundle,
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
/** One bill's sync ops stay ≤ 200 (03 §3); shared with refunds, deliveries and returns. */
export const MAX_CART_LINES = MAX_LINES_PER_DOCUMENT;
export const HELD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTE_MAX = 60;

export class CartFullError extends Error {
  constructor() {
    super(`A bill can have ${MAX_CART_LINES} lines`);
    this.name = 'CartFullError';
  }
}

/** A bundle row reached Sell without a recipe (legacy or damaged data). */
export class EmptyBundleError extends Error {
  constructor() {
    super('This bundle has no items');
    this.name = 'EmptyBundleError';
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
    reissue: null,
    backdate: null,
  };
}

export function isEmptyCart(cart: Cart): boolean {
  return (
    cart.lines.length === 0 &&
    !cart.customer_id &&
    !cart.bill_discount &&
    !cart.backdate &&
    !cart.reissue &&
    cart.note.trim() === '' &&
    (cart.overrides?.length ?? 0) === 0
  );
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

/** The same snapshot the server verifies (07 §6): the chosen method's cost, no fallback. */
export function unitCostOf(product: MasterRow, method: CostMethod): number {
  return method === 'last'
    ? Number(product.last_cost ?? 0)
    : Number(product.avg_cost ?? 0);
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

export type BundleRecipeItem = {
  product: MasterRow;
  qty_milli: number;
};

function bundleLines(cart: Cart, group: string): CartLine[] {
  return cart.lines.filter((line) => line.bundle_group === group);
}

export function bundleQtyOf(cart: Cart, group: string): number {
  return Number(bundleLines(cart, group)[0]?.bundle_qty ?? 0);
}

/** The bundle's shelf price when added; the operator can sell below it if permitted. */
export function bundleListPriceOf(cart: Cart, group: string): number {
  const first = bundleLines(cart, group)[0];
  return Number(first?.bundle_list_price ?? first?.bundle_price ?? 0);
}

/** Price the group discount applies to: a manual edit, else the shelf price. */
export function bundleBasePriceOf(cart: Cart, group: string): number {
  const first = bundleLines(cart, group)[0];
  return Number(
    first?.bundle_base_price ??
      first?.bundle_list_price ??
      first?.bundle_price ??
      0,
  );
}

/** Per-bundle manual discount currently applied to the group. */
export function bundleDiscountOf(cart: Cart, group: string): number {
  const first = bundleLines(cart, group)[0];
  if (!first) return 0;
  return Math.max(
    0,
    bundleBasePriceOf(cart, group) - Number(first.bundle_price ?? 0),
  );
}

/** Whole-bill total of the bundle group discounts. */
export function bundleDiscountTotal(cart: Cart): number {
  let total = 0;
  for (const [group, lines] of bundleGroupLines(cart)) {
    const qty = Number(lines[0]?.bundle_qty ?? 0);
    if (qty > 0) total += bundleDiscountOf(cart, group) * qty;
  }
  return total;
}

/** Net bundle price after a Rs or % group discount. */
export function bundleNetPrice(
  base: number,
  type: 'amount' | 'percent',
  value: number,
): number {
  if (value <= 0 || base <= 0) return base;
  if (type === 'percent')
    return Math.max(
      0,
      base - mulDivRound(base, Math.min(value, 10_000), 10_000),
    );
  return Math.max(0, base - value);
}

/** The group's component lines with the per-bundle quantity each snapshot carries. */
export function bundleGroupLines(cart: Cart): Map<string, CartLine[]> {
  const groups = new Map<string, CartLine[]>();
  for (const line of cart.lines) {
    if (!line.bundle_group) continue;
    const list = groups.get(line.bundle_group) ?? [];
    list.push(line);
    groups.set(line.bundle_group, list);
  }
  return groups;
}

type RecipeIdentity = {
  product_id?: string | null;
  bundle_component_qty_milli?: number;
};

/** Stable recipe identity used to merge the same bundle snapshot only. */
function recipeSignature(lines: readonly RecipeIdentity[]): string {
  return lines
    .map(
      (line) =>
        `${String(line.product_id)}:${Number(line.bundle_component_qty_milli ?? 0)}`,
    )
    .sort()
    .join('|');
}

/**
 * Adds whole bundles as one block of component lines (07 §3.4, screens/05).
 * The component prices are internal: the group total is the bundle price.
 */
export function addBundle(
  cart: Cart,
  bundle: MasterRow,
  recipe: readonly BundleRecipeItem[],
  qtyBundles: number,
  method: CostMethod,
): Cart {
  const price = Number(bundle.price ?? 0);
  const wanted = recipeSignature(
    recipe.map((item) => ({
      product_id: item.product.id,
      bundle_component_qty_milli: item.qty_milli,
    })),
  );
  const existing = cart.lines.find(
    (line) =>
      line.bundle_group !== undefined &&
      line.bundle_id === bundle.id &&
      Number(line.bundle_price) === price &&
      recipeSignature(bundleLines(cart, String(line.bundle_group))) === wanted,
  );
  if (existing) {
    const products = new Map(
      recipe.map((item) => [item.product.id, item.product]),
    );
    const current = bundleQtyOf(cart, String(existing.bundle_group));
    return updateBundleQty(
      cart,
      String(existing.bundle_group),
      current + qtyBundles,
      products,
      method,
    );
  }
  if (recipe.length === 0) throw new EmptyBundleError();
  if (cart.lines.length + recipe.length > MAX_CART_LINES)
    throw new CartFullError();
  const priced = priceBundle({
    bundle_price: price,
    bundle_qty: qtyBundles,
    components: recipe.map((item) => ({
      qty_milli: item.qty_milli,
      unit_cost: unitCostOf(item.product, method),
      unit_price: Number(item.product.price ?? 0),
    })),
  });
  const group = newId();
  const lines: CartLine[] = recipe.map((item, index) => {
    const result = priced.lines[index];
    if (!result) throw new Error('bundle recipe and price lines differ');
    return {
      key: newId(),
      product_id: item.product.id,
      name: String(item.product.name_en ?? ''),
      sku: String(item.product.sku ?? ''),
      qty_milli: result.qty_milli,
      unit_price: result.unit_price,
      list_price: result.unit_price,
      discount_type: 'amount',
      discount_value: result.discount,
      unit_cost: result.unit_cost,
      track_stock: item.product.track_stock === 1 ? 1 : 0,
      unit: String(item.product.unit ?? 'pc'),
      ...(item.product.image_key
        ? { image_key: String(item.product.image_key) }
        : {}),
      bundle_id: bundle.id,
      bundle_group: group,
      bundle_name: String(bundle.name_en ?? ''),
      bundle_qty: qtyBundles,
      bundle_price: price,
      bundle_list_price: price,
      bundle_base_price: price,
      bundle_component_qty_milli: item.qty_milli,
    };
  });
  return { ...cart, lines: [...lines, ...cart.lines] };
}

/** Re-runs the cost-weighted split for a quantity and effective bundle price. */
function repriceBundle(
  cart: Cart,
  group: string,
  qtyBundles: number,
  bundlePrice: number,
  products: ReadonlyMap<string, MasterRow>,
  method: CostMethod,
): Cart {
  const lines = bundleLines(cart, group);
  if (lines.length === 0 || qtyBundles <= 0) return cart;
  const priced = priceBundle({
    bundle_price: bundlePrice,
    bundle_qty: qtyBundles,
    components: lines.map((line) => {
      const product = line.product_id
        ? products.get(line.product_id)
        : undefined;
      return {
        qty_milli: Number(line.bundle_component_qty_milli ?? line.qty_milli),
        unit_cost: product ? unitCostOf(product, method) : line.unit_cost,
        unit_price: product ? Number(product.price ?? 0) : line.unit_price,
      };
    }),
  });
  let index = 0;
  const next = cart.lines.map((line) => {
    if (line.bundle_group !== group) return line;
    const result = priced.lines[index];
    index += 1;
    if (!result) return line;
    return {
      ...line,
      qty_milli: result.qty_milli,
      unit_price: result.unit_price,
      list_price: result.unit_price,
      discount_type: 'amount' as const,
      discount_value: result.discount,
      unit_cost: result.unit_cost,
      bundle_qty: qtyBundles,
      bundle_price: bundlePrice,
    };
  });
  return { ...cart, lines: next };
}

function setBundleBasePrice(cart: Cart, group: string, base: number): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line.bundle_group === group ? { ...line, bundle_base_price: base } : line,
    ),
  };
}

/** Re-runs the cost-weighted split for a new whole-bundle quantity; 0 removes the group. */
export function updateBundleQty(
  cart: Cart,
  group: string,
  qtyBundles: number,
  products: ReadonlyMap<string, MasterRow>,
  method: CostMethod,
): Cart {
  const lines = bundleLines(cart, group);
  if (lines.length === 0) return cart;
  if (qtyBundles <= 0) return removeBundle(cart, group);
  const first = lines[0] as CartLine;
  return repriceBundle(
    cart,
    group,
    qtyBundles,
    Number(first.bundle_price ?? 0),
    products,
    method,
  );
}

/** Edits the whole-bundle price and redistributes it across the component lines. */
export function updateBundlePrice(
  cart: Cart,
  group: string,
  bundlePrice: number,
  products: ReadonlyMap<string, MasterRow>,
  method: CostMethod,
): Cart {
  const lines = bundleLines(cart, group);
  if (lines.length === 0 || bundlePrice < 0) return cart;
  const first = lines[0] as CartLine;
  const qty = Number(first.bundle_qty ?? 0);
  if (qty <= 0) return cart;
  const next = repriceBundle(cart, group, qty, bundlePrice, products, method);
  // Typing a price replaces a previous discount control.
  const clean = {
    ...next,
    lines: next.lines.map((line) =>
      line.bundle_group === group
        ? {
            ...line,
            bundle_base_price: bundlePrice,
            bundle_discount_type: undefined,
            bundle_discount_value: undefined,
          }
        : line,
    ),
  };
  return clean;
}

/** Applies a Rs/% discount on the bundle shelf price as the new net group price. */
export function setBundleDiscount(
  cart: Cart,
  group: string,
  type: 'amount' | 'percent',
  value: number,
  products: ReadonlyMap<string, MasterRow>,
  method: CostMethod,
): Cart {
  const lines = bundleLines(cart, group);
  if (lines.length === 0) return cart;
  const first = lines[0] as CartLine;
  const qty = Number(first.bundle_qty ?? 0);
  if (qty <= 0) return cart;
  const base = bundleBasePriceOf(cart, group);
  const net = bundleNetPrice(base, type, value);
  const next = repriceBundle(cart, group, qty, net, products, method);
  const baseSet = setBundleBasePrice(next, group, base);
  return {
    ...baseSet,
    lines: baseSet.lines.map((line) =>
      line.bundle_group === group
        ? {
            ...line,
            bundle_discount_type: type,
            bundle_discount_value: Math.max(0, value),
          }
        : line,
    ),
  };
}

export function removeBundle(cart: Cart, group: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.bundle_group !== group) };
}

/** Bundle residual paisa is not a manual discount (07 §3.1). */
export function bundleResidualDiscount(cart: Cart, totals: CartResult): number {
  let residual = 0;
  for (const [index, line] of cart.lines.entries()) {
    if (line.bundle_id) residual += totals.lines[index]?.discount ?? 0;
  }
  return residual;
}

/** Manual discount share in basis points, excluding bundle rounding residuals. */
export function manualDiscountBp(cart: Cart, totals: CartResult): number {
  const manual =
    totals.item_discount_total +
    totals.bill_discount -
    bundleResidualDiscount(cart, totals) +
    bundleDiscountTotal(cart);
  if (manual <= 0 || totals.gross_total === 0) return 0;
  return mulDivRound(manual, 10_000, totals.gross_total);
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

/** Changes one line; quantity 0 removes it. Bundle components are read-only. */
export function updateLine(
  cart: Cart,
  key: string,
  patch: Partial<CartLine>,
): Cart {
  if (cart.lines.some((line) => line.key === key && line.bundle_group))
    throw new Error('bundle components cannot be edited individually');
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
  const line = cart.lines.find((l) => l.key === key);
  if (line?.bundle_group) return removeBundle(cart, line.bundle_group);
  return { ...cart, lines: cart.lines.filter((l) => l.key !== key) };
}

export function addOverride(cart: Cart, override: CartOverride): Cart {
  // A catalog price approval is per line; keep the other line approvals. Every other
  // permission is a single approval for the whole action.
  const rest = (cart.overrides ?? []).filter(
    (o) =>
      o.permission !== override.permission ||
      (override.permission === 'catalog.edit' &&
        o.bound_line !== override.bound_line),
  );
  return { ...cart, overrides: [...rest, override] };
}

/**
 * The parts of a cart a manager approval is bound to. Any line, quantity, price,
 * discount, customer or reissue change produces a different signature, so the
 * previous approval no longer applies.
 */
export function cartSignature(cart: Cart): string {
  return JSON.stringify({
    customer: cart.customer_id ?? null,
    reissue: cart.reissue?.sale_id ?? null,
    backdate: cart.backdate ?? null,
    discount: cart.bill_discount ?? null,
    lines: cart.lines.map((line) => [
      line.key,
      line.product_id,
      line.qty_milli,
      line.unit_price,
      line.unit_cost,
      line.discount_type ?? null,
      line.discount_value ?? 0,
      line.bundle_group ?? null,
      line.bundle_qty ?? null,
      line.bundle_price ?? null,
      line.bundle_list_price ?? null,
      line.bundle_base_price ?? null,
      line.bundle_discount_type ?? null,
      line.bundle_discount_value ?? null,
    ]),
  });
}

/** Whether the cart still matches the approval given for `permission`. */
export function overrideMatches(
  cart: Cart,
  permission: string,
  options: { udhaar?: number; line?: string; price?: number } = {},
): boolean {
  const overrides = (cart.overrides ?? []).filter(
    (candidate) => candidate.permission === permission,
  );
  if (permission === 'catalog.edit')
    return overrides.some(
      (override) =>
        override.bound_line === options.line &&
        override.bound_price === options.price,
    );
  const override = overrides[0];
  if (!override) return false;
  if (override.bound_cart !== cartSignature(cart)) return false;
  if (permission === 'udhaar.hard_limit')
    return (
      options.udhaar !== undefined && override.bound_udhaar === options.udhaar
    );
  return true;
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
  return mulDivRound(line.qty_milli, line.unit_price, 1000);
}

/** What Take payment needs before it opens (07 §3.1–§3.2). */
export function paymentChecks(
  cart: Cart,
  totals: CartResult,
  staff: { maxDiscountBp: number; canBelowCost: boolean; canDiscount: boolean },
): { belowCost: boolean; discount: boolean } {
  const anyBelow = totals.lines.some((l) => l.below_cost === 1);
  const manual = manualDiscountBp(cart, totals);
  const discounted = manual > 0;
  // A staff member whose `sale.discount` permission is revoked cannot override the
  // permission itself; only the max-discount limit is overrideable (05 §6).
  const overLimit = discounted && manual > staff.maxDiscountBp;
  return {
    belowCost:
      anyBelow &&
      !staff.canBelowCost &&
      !overrideMatches(cart, 'sale.below_cost'),
    discount: overLimit && !overrideMatches(cart, 'sale.discount'),
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

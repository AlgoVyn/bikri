import type { BikriDb, Cart, MasterRow } from '@bikri/db';
import { addProduct, emptyCart, shopMoney, updateLine } from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import type { completeSale, settle } from './sale.ts';
import { freshDb } from './testDb.ts';

export const NOW = Date.UTC(2026, 9, 27, 9, 0);
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

/** A set-up shop (branch, owner st-1, device dev-1 code A) for data tests. */
export async function readyDb(prefix = 'cat'): Promise<BikriDb> {
  const db = freshDb(prefix);
  await db.branches.add({
    id: 'br-1',
    name: 'Main',
    bill_prefix: 'A',
    is_default: 1,
    ...row,
  });
  await db.staff.add({
    id: 'st-1',
    name: 'Adnan',
    role: 'owner',
    active: 1,
    permissions_json: '{}',
    ...row,
  });
  await db.expense_categories.add({
    id: 'ec-1',
    code: 'rent',
    name: 'Rent',
    sort_order: 1,
    ...row,
  });
  await db.kv.put({
    key: 'device',
    value: {
      id: 'dev-1',
      name: 'Counter 1',
      code: 'A',
      branch_id: 'br-1',
      is_admin: true,
    },
  });
  return db;
}

/** Adds the `shop` row with money settings. */
export async function addShop(
  db: BikriDb,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.shop.put({
    id: 'shop',
    name: 'Bilal Mobile',
    business_type: 'mobile',
    phone: '+923001234567',
    address: 'Main Bazaar',
    tax_rate_bp: 0,
    tax_mode: 'exclusive',
    round_total_to: 100,
    cost_method: 'avg',
    show_cost_on_till: 0,
    ...row,
    ...extra,
  });
}

// --- sale fixtures (T-017/T-018) ---

export async function shopWithStock(prefix = 'sale') {
  const db = await readyDb(prefix);
  const ctx = await ledgerContext(db, 'st-1');
  const phone = await saveNewProduct(
    db,
    {
      name_en: 'Galaxy A15',
      price: 4200000,
      cost: 3800000,
      opening_milli: 1000,
      warranty_days: 365,
    },
    ctx,
    { now: NOW },
  );
  const buds = await saveNewProduct(
    db,
    { name_en: 'Earbuds', price: 350000, cost: 200000, opening_milli: 5000 },
    ctx,
    { now: NOW },
  );
  await db.outbox.clear();
  return { db, ctx, phone, buds };
}

export function t2Cart(phone: MasterRow, buds: MasterRow): Cart {
  let cart = addProduct(emptyCart('c1'), phone, 1000, 'avg');
  cart = updateLine(cart, cart.lines[0]?.key ?? '', {
    discount_type: 'amount',
    discount_value: 200000,
  });
  cart = addProduct(cart, buds, 1000, 'avg');
  return { ...cart, bill_discount: { type: 'amount', value: 50000 } };
}

export const sale = (
  cart: Cart,
  rows: Parameters<typeof settle>[1],
  extra: Partial<Parameters<typeof completeSale>[1]> = {},
) =>
  ({
    saleId: `sale-${Math.random()}`,
    cartId: 'c1' as const,
    cart,
    money: shopMoney(null),
    rows,
    print: false,
    maxDiscountBp: 10000,
    ...extra,
  }) satisfies Parameters<typeof completeSale>[1];

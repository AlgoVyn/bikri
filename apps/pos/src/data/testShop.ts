import type { BikriDb } from '@bikri/db';
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

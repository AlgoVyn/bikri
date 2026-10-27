import { businessDate, hashPin, newId } from '@bikri/core';
import { deleteTenantDb } from '@bikri/db';
import { ledgerContext, saveNewProduct } from '../data/catalog.ts';
import { closeDb, getDb } from '../data/db.ts';
import { ensureLocalTenant } from '../data/localTenant.ts';
import { finishSetup } from '../data/setup.ts';
import { writeAction } from '../data/write.ts';
import { useSession } from '../state/session.ts';
import { seedSampleDay } from './sampleDay.ts';

/** Fresh `bikri-dev` database with a finished setup wizard (owner PIN 4826). */
export async function seedReadyShop(): Promise<void> {
  closeDb();
  await deleteTenantDb('dev');
  const db = getDb();
  await ensureLocalTenant(db);
  await finishSetupHere(db);
}

/** Runs the wizard's Finish on the open shop (an enrolled one too: its ops then sync). */
export async function finishSetupHere(db = getDb()): Promise<void> {
  await finishSetup(
    db,
    {
      shop: {
        name: 'Algovyn Mobiles',
        business_type: 'mobile',
        phone: '+923001234567',
        address: 'Hall Road, Lahore',
        city: '',
        ntn: '',
        strn: '',
      },
      owner: { name: 'Adnan', pin: '4826' },
      receipt: {
        header: '',
        footer: '',
        tax_rate_bp: 0,
        inclusive: false,
        round_total_to: 100,
      },
      product: null,
    },
    { pinHash: await hashPin('4826', 1000) },
  );
}

export async function resetDevDb(): Promise<void> {
  closeDb();
  await deleteTenantDb('dev');
}

/** Unlocks the till as a new staff member of `role` (stands in for the PIN lock until T-035). */
export async function unlockAs(
  role: 'owner' | 'manager' | 'cashier',
  name = 'Sana',
): Promise<string> {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  await db.staff.add({
    id,
    name,
    role,
    pin_hash: '',
    pin_salt: '',
    pin_iterations: 0,
    active: 1,
    permissions_json: '{}',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 0,
  });
  useSession.getState().unlock({ staff_id: id, role, unlocked_at: now });
  return id;
}

/** seedSampleDay on today's business date in the dev shop. */
export async function seedTodaySales(): Promise<void> {
  await seedSampleDay(getDb(), businessDate(Date.now()));
}

export type TestProduct = {
  name: string;
  name_ur?: string;
  price: number;
  cost?: number;
  barcode?: string;
  stock?: number;
  track?: boolean;
};

/** Products through the real save path (e2e only). Prices and costs in paisa, stock in units. */
export async function seedProducts(list: TestProduct[]): Promise<string[]> {
  const db = getDb();
  const owner = (await db.staff.toArray()).find((s) => s.role === 'owner');
  const ctx = await ledgerContext(db, owner?.id ?? '');
  const ids: string[] = [];
  for (const p of list) {
    const row = await saveNewProduct(
      db,
      {
        name_en: p.name,
        ...(p.name_ur ? { name_ur: p.name_ur } : {}),
        price: p.price,
        cost: p.cost,
        barcodes: p.barcode ? [p.barcode] : [],
        opening_milli: (p.stock ?? 0) * 1000,
        track_stock: p.track ?? true,
      },
      ctx,
    );
    ids.push(row.id);
  }
  return ids;
}

/** `n` products in one bulk write for the Sell performance check (screens/05 AC 2). */
export async function seedManyProducts(n: number): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const words = [
    'Cable',
    'Charger',
    'Cover',
    'Earbuds',
    'Glass',
    'Battery',
    'Stand',
    'Card',
    'Adapter',
    'Speaker',
  ];
  const rows = Array.from({ length: n }, (_, i) => ({
    id: newId(),
    name_en: `${words[i % words.length]} ${String(i).padStart(4, '0')}`,
    name_ur: '',
    brand: '',
    category_id: null,
    sku: `BULK-${i}`,
    unit: 'pc',
    price: 10000 + i * 100,
    last_cost: 0,
    avg_cost: 0,
    min_stock_milli: 0,
    track_stock: 0,
    warranty_days: 0,
    image_key: null,
    notes: '',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 1,
  }));
  await db.products.bulkAdd(rows);
}

/** A customer with an optional credit limit and opening balance (paisa), e2e only. */
export async function seedCustomer(c: {
  name: string;
  phone?: string;
  limit?: number | null;
  hard?: boolean;
  balance?: number;
}): Promise<string> {
  const db = getDb();
  const owner = (await db.staff.toArray()).find((s) => s.role === 'owner');
  const ctx = await ledgerContext(db, owner?.id ?? '');
  return writeAction(db, async (w) => {
    const row = await w.create('customers', {
      name: c.name,
      phone: c.phone ?? '',
      address: '',
      note: '',
      credit_limit: c.limit ?? null,
      hard_limit: c.hard ? 1 : 0,
    });
    if (c.balance) {
      const now = Date.now();
      await w.insert('ledger_entries', {
        id: newId(now),
        party_type: 'customer',
        party_id: row.id,
        amount: c.balance,
        source_type: 'opening',
        source_id: null,
        note: '',
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: businessDate(now),
        created_at: now,
      });
    }
    return row.id;
  });
}

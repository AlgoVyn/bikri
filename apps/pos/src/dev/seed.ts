import { businessDate, hashPin, newId } from '@bikri/core';
import { deleteTenantDb } from '@bikri/db';
import { ledgerContext, saveNewProduct } from '../data/catalog.ts';
import { closeDb, getDb } from '../data/db.ts';
import { ensureLocalTenant } from '../data/localTenant.ts';
import { finishSetup } from '../data/setup.ts';
import { createSupplier } from '../data/suppliers.ts';
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
    { pinHash: await hashPin('4826') },
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
  sku?: string;
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
        sku: p.sku,
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

/** A mobile-shop catalogue for the local demo (paisa, stock in units). */
export const DEMO_PRODUCTS: TestProduct[] = [
  {
    name: 'Samsung Galaxy A15 128 GB',
    name_ur: 'سام سنگ گلیکسی اے 15 128 جی بی',
    price: 5299000,
    cost: 4850000,
    barcode: '8800000000015',
    sku: 'SAM-A15',
    stock: 6,
  },
  {
    name: 'Infinix Hot 40',
    name_ur: 'انفینکس ہاٹ 40',
    price: 3199000,
    cost: 2900000,
    barcode: '8800000000022',
    sku: 'INF-H40',
    stock: 11,
  },
  {
    name: 'Samsung Galaxy A05',
    name_ur: 'سام سنگ گلیکسی اے 05',
    price: 2699000,
    cost: 2450000,
    barcode: '8800000000039',
    sku: 'SAM-A05',
    stock: 4,
  },
  {
    name: 'Bluetooth speaker',
    name_ur: 'بلوٹوتھ اسپیکر',
    price: 289900,
    cost: 210000,
    barcode: '8800000000046',
    sku: 'SPK-BT1',
    stock: 12,
  },
  {
    name: 'Wireless earbuds',
    name_ur: 'وائرلیس ایئربڈز',
    price: 349900,
    cost: 260000,
    barcode: '8800000000053',
    sku: 'EAR-WL1',
    stock: 8,
  },
  {
    name: 'Power bank 10000 mAh',
    name_ur: 'پاور بینک 10000 mAh',
    price: 449900,
    cost: 340000,
    barcode: '8800000000060',
    sku: 'PWB-10K',
    stock: 4,
  },
  {
    name: 'Type-C fast charger 25W',
    name_ur: 'ٹائپ سی فاسٹ چارجر 25W',
    price: 129900,
    cost: 90000,
    barcode: '8800000000077',
    sku: 'CHG-25W',
    stock: 34,
  },
  {
    name: 'USB-C cable 1 m',
    name_ur: 'USB-C کیبل 1 میٹر',
    price: 49900,
    cost: 25000,
    barcode: '8800000000084',
    sku: 'CBL-UC1',
    stock: 60,
  },
  {
    name: 'Clear phone cover',
    name_ur: 'شفاف فون کور',
    price: 39900,
    cost: 18000,
    barcode: '8800000000091',
    sku: 'COV-CLR',
    stock: 25,
  },
  {
    name: 'Tempered glass',
    name_ur: 'ٹمپرڈ گلاس',
    price: 24900,
    cost: 12000,
    barcode: '8800000000107',
    sku: 'GLS-TMP',
    stock: 2,
  },
  {
    name: 'Car mount',
    price: 89900,
    cost: 55000,
    barcode: '8800000000114',
    sku: 'MNT-CAR',
    stock: 9,
  },
  {
    name: '64 GB memory card',
    price: 189900,
    cost: 130000,
    barcode: '8800000000121',
    sku: 'MEM-64',
    stock: 15,
  },
  {
    name: 'SIM ejector pin',
    price: 9900,
    cost: 2000,
    barcode: '8800000000138',
    sku: 'SIM-PIN',
    stock: 0,
  },
  {
    name: 'Screen repair labour',
    price: 150000,
    cost: 0,
    sku: 'SRV-SCR',
    stock: 0,
    track: false,
  },
];

/**
 * Reset the local dev shop to a ready shop with a demo catalogue, a customer, a
 * supplier and today's sample sales (dev only). The caller reloads the app afterwards.
 */
export async function seedDemoShop(): Promise<void> {
  await seedReadyShop();
  await seedProducts(DEMO_PRODUCTS);
  await seedCustomer({
    name: 'Bilal Ahmed',
    phone: '+923001112233',
    balance: 1250000,
    limit: 5000000,
  });
  await seedSupplier({
    name: 'Hall Road Mobiles',
    phone: '+924235761234',
    opening: 8500000,
  });
  await seedTodaySales();
}

/** Supplier for E2E admin screens; returns its id. */
export async function seedSupplier(s: {
  name: string;
  phone?: string;
  opening?: number;
}): Promise<string> {
  const db = getDb();
  const owner = (await db.staff.toArray()).find((row) => row.role === 'owner');
  const ctx = await ledgerContext(db, owner?.id ?? '');
  const row = await createSupplier(
    db,
    {
      name: s.name,
      phone: s.phone ?? '',
      opening: s.opening ?? 0,
    },
    ctx,
    owner?.id ?? null,
  );
  return row.id;
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

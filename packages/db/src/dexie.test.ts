import 'fake-indexeddb/auto';
import { LEDGER_TABLES, MASTER_TABLES } from '@bikri/core';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearTenantDb,
  DEXIE_SCHEMA_V6,
  DEXIE_SCHEMA_V7,
  DEXIE_SCHEMA_V9,
  DEXIE_SCHEMA_V10,
  DEXIE_SCHEMA_V12,
  DEXIE_SCHEMA_V17,
  DEXIE_SCHEMA_V18,
  DEXIE_SCHEMA_VERSION,
  deleteTenantDb,
  LOCAL_ONLY_TABLES,
  openTenantDb,
  tenantDbName,
} from './dexie.ts';

const opened: ReturnType<typeof openTenantDb>[] = [];
function open(id: string) {
  const db = openTenantDb(id);
  opened.push(db);
  return db;
}

afterEach(async () => {
  for (const db of opened.splice(0)) {
    db.close();
    await deleteTenantDb(db.tenantId);
  }
});

describe('Dexie schema (02 §3)', () => {
  it('names one database per tenant and rejects odd ids', () => {
    expect(tenantDbName('01JTENANTAAAAAAAAAAAAAAAAA')).toBe(
      'bikri-01JTENANTAAAAAAAAAAAAAAAAA',
    );
    expect(tenantDbName('dev')).toBe('bikri-dev');
    expect(() => tenantDbName('')).toThrow();
    expect(() => tenantDbName('../x')).toThrow();
  });

  it('has every synced table plus devices, sync_conflicts and the local-only tables', () => {
    const tables = Object.keys(DEXIE_SCHEMA_V18).sort();
    expect(tables).toEqual(
      [
        ...MASTER_TABLES,
        ...LEDGER_TABLES,
        'devices',
        'sync_conflicts',
        ...LOCAL_ONLY_TABLES,
      ].sort(),
    );
  });

  it('upgrades a V6 database: backfills line and refund dates, product kind, then adds V10 indexes', async () => {
    const old = new Dexie(tenantDbName('upgrade-v6'));
    old.version(6).stores(DEXIE_SCHEMA_V6);
    await old.open();
    await old.table('sales').add({
      id: 's1',
      invoice_no: 'INV-A-1',
      business_date: '2026-10-27',
    });
    await old.table('sale_lines').add({
      id: 'l1',
      sale_id: 's1',
      product_id: 'p1',
    });
    await old.table('products').add({
      id: 'p1',
      sku: 'P1',
      name_en: 'Phone',
    });
    old.close();

    const db = open('upgrade-v6');
    await db.open();
    expect((await db.sale_lines.get('l1'))?.business_date).toBe('2026-10-27');
    expect((await db.products.get('p1'))?.kind).toBe('simple');
    expect(
      db.products.schema.indexes.some((index) => index.name === 'track_stock'),
    ).toBe(true);
    expect(db.tables.map((table) => table.name)).toContain('bundle_items');
  });

  it('upgrades a V7 database without losing line dates and backfills product kind', async () => {
    const old = new Dexie(tenantDbName('upgrade-v7'));
    old.version(7).stores(DEXIE_SCHEMA_V7);
    await old.open();
    await old.table('products').add({
      id: 'p1',
      sku: 'P1',
      name_en: 'Phone',
    });
    await old.table('sale_lines').add({
      id: 'l1',
      sale_id: 's1',
      product_id: 'p1',
      business_date: '2026-10-27',
    });
    old.close();

    const db = open('upgrade-v7');
    await db.open();
    expect((await db.products.get('p1'))?.kind).toBe('simple');
    expect((await db.sale_lines.get('l1'))?.business_date).toBe('2026-10-27');
    expect(
      db.sync_conflicts.schema.indexes.some(
        (index) => index.name === 'resolution',
      ),
    ).toBe(true);
  });

  it('V14 drops the unused standalone bundle_id index', async () => {
    const db = open('upgrade-v14');
    await db.open();
    const names = db.sale_lines.schema.indexes.map((index) => index.name);
    expect(names).not.toContain('bundle_id');
    expect(names).toContain('[bundle_id+business_date]');
    db.close();
  });

  it('V15 drops the unused outbox.created_at index', async () => {
    const db = open('upgrade-v15');
    await db.open();
    const names = db.outbox.schema.indexes.map((index) => index.name);
    expect(names).not.toContain('created_at');
    expect(names).toContain('[status+seq]');
    db.close();
  });

  it('V18 drops unqueried indexes, adds the conflict lookup and backfills supplier delivery dates', async () => {
    const old = new Dexie(tenantDbName('upgrade-v18'));
    old.version(17).stores(DEXIE_SCHEMA_V17);
    await old.open();
    await old.table('purchases').bulkAdd([
      { id: 'p1', supplier_id: 's1', business_date: '2026-10-01' },
      { id: 'p2', supplier_id: 's1', business_date: '2026-10-05' },
      { id: 'p3', supplier_id: 's2', business_date: '2026-10-02' },
    ]);
    await old.table('party_balances').add({
      party_type: 'supplier',
      party_id: 's1',
      balance: 100,
      last_activity_at: 1,
      oldest_unpaid_at: 1,
    });
    old.close();

    const db = open('upgrade-v18');
    await db.open();
    expect(await db.party_balances.get(['supplier', 's1'])).toMatchObject({
      balance: 100,
      last_delivery_date: '2026-10-05',
    });
    // A supplier with only free deliveries has no ledger row; the cache still names it.
    expect(await db.party_balances.get(['supplier', 's2'])).toMatchObject({
      balance: 0,
      last_delivery_date: '2026-10-02',
    });
    const names = (table: string) =>
      db.table(table).schema.indexes.map((index) => index.name);
    expect(names('payments')).not.toContain('[party_type+party_id]');
    expect(names('supplier_returns')).not.toContain('[supplier_id+created_at]');
    expect(names('product_barcodes')).not.toContain('deleted_at');
    expect(names('bundle_items')).not.toContain('deleted_at');
    expect(names('file_queue')).not.toContain('created_at');
    expect(names('file_queue')).toContain('[status+created_at]');
    expect(names('sync_conflicts')).toContain('[tbl+row_id]');
    expect(names('sync_conflicts')).toContain('resolution');
    expect(db.verno).toBe(DEXIE_SCHEMA_VERSION);
  });

  it('upgrades a V12 database: repairs refund lines pulled without a date', async () => {
    const old = new Dexie(tenantDbName('upgrade-v12'));
    old.version(12).stores(DEXIE_SCHEMA_V12);
    await old.open();
    await old.table('refunds').add({
      id: 'r1',
      business_date: '2026-10-27',
    });
    await old.table('refund_lines').add({
      id: 'l1',
      refund_id: 'r1',
      sale_line_id: 's1',
    });
    old.close();

    const db = open('upgrade-v12');
    await db.open();
    expect((await db.refund_lines.get('l1'))?.business_date).toBe('2026-10-27');
    expect(db.verno).toBe(DEXIE_SCHEMA_VERSION);
  });

  it('upgrades a V9 database: backfills refund line dates from their refunds', async () => {
    const old = new Dexie(tenantDbName('upgrade-v9'));
    old.version(9).stores(DEXIE_SCHEMA_V9);
    await old.open();
    await old.table('refunds').add({
      id: 'r1',
      business_date: '2026-10-27',
    });
    await old.table('refund_lines').add({
      id: 'l1',
      refund_id: 'r1',
      sale_line_id: 's1',
    });
    old.close();

    const db = open('upgrade-v9');
    await db.open();
    expect((await db.refund_lines.get('l1'))?.business_date).toBe('2026-10-27');
    expect(
      db.refund_lines.schema.indexes.some(
        (index) => index.name === 'business_date',
      ),
    ).toBe(true);
  });

  it('adds the bundle+date index and backfills the last payment', async () => {
    const old = new Dexie(tenantDbName('upgrade-v10'));
    old.version(10).stores(DEXIE_SCHEMA_V10);
    await old.open();
    await old.table('ledger_entries').add({
      id: 'l1',
      party_type: 'customer',
      party_id: 'c1',
      amount: -500,
      source_type: 'payment',
      created_at: 42,
    });
    await old.table('party_balances').add({
      party_type: 'customer',
      party_id: 'c1',
      balance: -500,
      last_activity_at: 42,
      oldest_unpaid_at: null,
    });
    old.close();

    const db = open('upgrade-v10');
    await db.open();
    expect(
      (await db.party_balances.get(['customer', 'c1']))?.last_payment_at,
    ).toBe(42);
    expect(
      db.sale_lines.schema.indexes.some(
        (index) => index.name === '[bundle_id+business_date]',
      ),
    ).toBe(true);
  });

  it('V12 drops unused indexes and adds the compound ones', async () => {
    const db = open('v12-indexes');
    await db.open();
    const names = (table: string) =>
      db.table(table).schema.indexes.map((index) => index.name);
    expect(names('outbox')).toContain('[status+seq]');
    expect(names('outbox')).not.toContain('status');
    expect(names('file_queue')).toContain('[status+created_at]');
    expect(names('sale_voids')).toContain('business_date');
    expect(names('products')).not.toContain('name_en');
    expect(names('sync_conflicts')).toContain('resolution');
    expect(names('sync_conflicts')).not.toContain('row_id');
  });

  it('opens with the expected indexes and no tenant_id anywhere', async () => {
    const db = open('dev');
    await db.open();
    expect(db.name).toBe('bikri-dev');
    expect(
      db.sales.schema.indexes.find((i) => i.name === 'invoice_no')?.unique,
    ).toBe(true);
    expect(
      db.product_barcodes.schema.indexes.find((i) => i.name === 'barcode')
        ?.unique,
    ).toBe(false);
    const quoteIndexes = db.quotations.schema.indexes.map((i) => i.name);
    expect(quoteIndexes).toContain('[device_id+quote_seq]');
    expect(quoteIndexes).not.toContain('customer_id');
    expect(db.quotation_lines.schema.indexes.map((i) => i.name)).not.toContain(
      'product_id',
    );
    for (const t of db.tables) {
      expect(
        t.schema.indexes.some((i) => i.name.includes('tenant_id')),
        t.name,
      ).toBe(false);
    }
  });

  it('keeps two tenant databases apart even with colliding ids', async () => {
    const a = open('tenant-a');
    const b = open('tenant-b');
    const row = {
      id: 'p1',
      name_en: 'Phone X',
      sku: 'PHO-1',
      created_at: 1,
      updated_at: 1,
      rev: 0,
    };
    await a.products.put(row);
    await b.products.put({ ...row, name_en: 'Charger' });
    expect((await a.products.get('p1'))?.name_en).toBe('Phone X');
    expect((await b.products.get('p1'))?.name_en).toBe('Charger');
    expect(await a.products.count()).toBe(1);
    await deleteTenantDb('tenant-a').catch(() => undefined);
  });

  it('clears every store without deleting the database', async () => {
    const db = open('clear-a');
    await db.kv.put({ key: 'secret', value: 'old-shop' });
    await db.categories.put({
      id: 'c1',
      name_en: 'Phones',
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      updated_by: null,
      rev: 1,
    });
    db.close();
    await clearTenantDb('clear-a');
    const after = open('clear-a');
    expect(await after.kv.count()).toBe(0);
    expect(await after.categories.count()).toBe(0);
    expect(await Dexie.getDatabaseNames()).toContain('bikri-clear-a');
  });

  it('deletes a tenant database without touching the other', async () => {
    const a = open('del-a');
    const b = open('del-b');
    await a.kv.put({ key: 'x', value: 1 });
    await b.kv.put({ key: 'x', value: 2 });
    a.close();
    await deleteTenantDb('del-a');
    expect(await Dexie.getDatabaseNames()).not.toContain('bikri-del-a');
    expect((await b.kv.get('x'))?.value).toBe(2);
  });
});

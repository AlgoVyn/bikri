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
    const tables = Object.keys(DEXIE_SCHEMA_V10).sort();
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

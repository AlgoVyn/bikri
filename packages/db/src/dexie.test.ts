import 'fake-indexeddb/auto';
import { LEDGER_TABLES, MASTER_TABLES } from '@bikri/core';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEXIE_SCHEMA_V1,
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
    const tables = Object.keys(DEXIE_SCHEMA_V1).sort();
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

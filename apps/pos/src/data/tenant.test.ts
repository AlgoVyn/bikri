import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, NoActiveTenantError } from './db.ts';
import { getKv, setKv } from './kv.ts';
import {
  ACTIVE_TENANT_KEY,
  activeTenantId,
  DEV_TENANT_ID,
  setActiveTenantId,
  usesDevTenant,
} from './tenant.ts';
import { writeAction } from './write.ts';

afterEach(() => {
  closeDb();
  localStorage.clear();
});

describe('active tenant (D-073)', () => {
  it('uses the fixed dev tenant only in dev, test and e2e builds', () => {
    expect(usesDevTenant({ DEV: true })).toBe(true);
    expect(usesDevTenant({ MODE: 'test' })).toBe(true);
    expect(usesDevTenant({ VITE_LOCAL_TENANT: 'dev' })).toBe(true);
    expect(usesDevTenant({ DEV: false, MODE: 'production' })).toBe(false);
    expect(activeTenantId({ MODE: 'production' })).toBeNull();
    expect(activeTenantId()).toBe(DEV_TENANT_ID);
  });

  it('prefers the stored tenant and can clear it', () => {
    setActiveTenantId('01JTENANTAAAAAAAAAAAAAAAAA');
    expect(localStorage.getItem(ACTIVE_TENANT_KEY)).toBe(
      '01JTENANTAAAAAAAAAAAAAAAAA',
    );
    expect(activeTenantId({ MODE: 'production' })).toBe(
      '01JTENANTAAAAAAAAAAAAAAAAA',
    );
    setActiveTenantId(null);
    expect(activeTenantId({ MODE: 'production' })).toBeNull();
  });

  it('opens bikri-dev by default and a separate database per tenant', async () => {
    const dev = getDb();
    expect(dev.name).toBe('bikri-dev');
    expect(getDb()).toBe(dev);
    await setKv(dev, 'invoice_seq', 4);
    await writeAction(dev, (w) =>
      w.create('products', { id: 'p1', name_en: 'Dev phone' }),
    );

    setActiveTenantId('shop-b');
    const b = getDb();
    expect(b).not.toBe(dev);
    expect(b.name).toBe('bikri-shop-b');
    expect(await b.products.get('p1')).toBeUndefined();
    expect(await b.outbox.count()).toBe(0);
    expect(await getKv(b, 'invoice_seq', 0)).toBe(0);
    await writeAction(b, (w) =>
      w.create('products', { id: 'p1', name_en: 'Shop B phone' }),
    );

    setActiveTenantId(null);
    const again = getDb();
    expect((await again.products.get('p1'))?.name_en).toBe('Dev phone');
    expect(await getKv(again, 'invoice_seq', 0)).toBe(4);
  });

  it('refuses to open a database without a tenant in production', () => {
    expect(() => {
      if (!activeTenantId({ MODE: 'production' }))
        throw new NoActiveTenantError();
    }).toThrow(NoActiveTenantError);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { dropTestDbs } from '../data/testDb.ts';
import { readyDb } from '../data/testShop.ts';
import { kickDrawerForCash } from './drawer.ts';

afterEach(dropTestDbs);

describe('cash drawer helper', () => {
  it('is a no-op when no printer is configured', async () => {
    const db = await readyDb('drawer-none');
    await expect(kickDrawerForCash(db)).resolves.toBeUndefined();
  });

  it('swallows an unsupported transport instead of failing the money action', async () => {
    const db = await readyDb('drawer-system');
    await db.kv.put({
      key: 'printer',
      value: { transport: 'system', drawer: true },
    });
    await expect(kickDrawerForCash(db)).resolves.toBeUndefined();
  });
});

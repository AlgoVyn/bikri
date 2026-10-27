import { afterEach, describe, expect, it } from 'vitest';
import { setKv } from '../data/kv.ts';
import { dropTestDbs } from '../data/testDb.ts';
import { addShop, readyDb } from '../data/testShop.ts';
import {
  DEFAULT_PREFS,
  loadDevicePrefs,
  saveDevicePrefs,
} from './devicePrefs.ts';

afterEach(dropTestDbs);

describe('device preferences', () => {
  it('round-trips the auto-lock timeout with the other display settings', async () => {
    const db = await readyDb('prefs');
    await addShop(db, { name: 'Prefs' });
    expect(await loadDevicePrefs(db)).toEqual(DEFAULT_PREFS);
    await saveDevicePrefs(db, {
      ...DEFAULT_PREFS,
      theme: 'dark',
      textSize: '115',
      autoLockMinutes: 2,
    });
    expect(await loadDevicePrefs(db)).toMatchObject({
      theme: 'dark',
      textSize: '115',
      autoLockMinutes: 2,
    });
    // Older builds stored only the separate key.
    await setKv(db, 'ui.prefs', { theme: 'light', textSize: '130' });
    expect((await loadDevicePrefs(db)).autoLockMinutes).toBe(2);
  });
});

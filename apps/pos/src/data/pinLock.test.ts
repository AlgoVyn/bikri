import { hashPin } from '@bikri/core';
import { afterEach, describe, expect, it } from 'vitest';
import { setKv } from './kv.ts';
import {
  isPinTaken,
  lockedUntil,
  lockoutMs,
  lockProfiles,
  triesLeft,
  tryUnlock,
  verifyPinWithLockout,
} from './pinLock.ts';
import { dropTestDbs, freshDb } from './testDb.ts';

afterEach(() => dropTestDbs());

async function staffDb() {
  const db = freshDb('pin');
  const base = {
    active: 1,
    deleted_at: null,
    created_at: 1,
    updated_at: 1,
    rev: 1,
    permissions_json: '{}',
  };
  await db.staff.bulkAdd([
    {
      id: 'c',
      name: 'Zara',
      role: 'cashier',
      ...base,
      ...(await hashPin('2580', 1000)),
    },
    {
      id: 'o',
      name: 'Adnan',
      role: 'owner',
      ...base,
      ...(await hashPin('4826', 1000)),
    },
    {
      id: 'm',
      name: 'Bilal',
      role: 'manager',
      ...base,
      ...(await hashPin('1357', 1000)),
    },
    {
      id: 'x',
      name: 'Gone',
      role: 'cashier',
      ...base,
      active: 0,
      ...(await hashPin('1357', 1000)),
    },
  ]);
  return db;
}

describe('PIN lock (05 §4)', () => {
  it('lockout steps', () => {
    expect([4, 5, 6, 10, 15, 20, 25].map(lockoutMs)).toEqual([
      0, 300_000, 0, 1_800_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(triesLeft(1)).toBe(4);
    expect(triesLeft(6)).toBe(4);
  });

  it('orders profiles owner → manager → cashier and hides inactive staff', async () => {
    const db = await staffDb();
    expect((await lockProfiles(db)).map((s) => s.id)).toEqual(['o', 'm', 'c']);
  });

  it('5 wrong PINs lock only that profile for 5 minutes (screens/03 AC 2)', async () => {
    const db = await staffDb();
    const now = 1_000_000;
    for (let i = 1; i <= 4; i += 1)
      expect(await tryUnlock(db, 'c', '0000', now)).toEqual({
        kind: 'wrong',
        triesLeft: 5 - i,
      });
    expect(await tryUnlock(db, 'c', '0000', now)).toEqual({
      kind: 'locked',
      until: now + 300_000,
    });
    expect(await tryUnlock(db, 'c', '2580', now + 1000)).toEqual({
      kind: 'locked',
      until: now + 300_000,
    });
    expect(await lockedUntil(db, 'c', now)).toBe(now + 300_000);
    expect((await tryUnlock(db, 'm', '1357', now)).kind).toBe('ok');
    const later = await tryUnlock(db, 'c', '2580', now + 300_001);
    expect(later.kind).toBe('ok');
    expect(await lockedUntil(db, 'c', now)).toBeNull();
    expect((await tryUnlock(db, 'x', '1357', now)).kind).toBe('wrong');
    await setKv(db, 'pin_failures', { o: { count: 9, until: 0 } });
    expect(await tryUnlock(db, 'o', '0000', now)).toEqual({
      kind: 'locked',
      until: now + 1_800_000,
    });
  });

  it('applies the same lockout to overrides and detects duplicate PINs', async () => {
    const db = await staffDb();
    const now = 2_000_000;
    for (let i = 1; i <= 4; i += 1)
      expect(await verifyPinWithLockout(db, 'o', '0000', now)).toEqual({
        kind: 'wrong',
        triesLeft: 5 - i,
      });
    expect(await verifyPinWithLockout(db, 'o', '0000', now)).toEqual({
      kind: 'locked',
      until: now + 300_000,
    });
    expect(await verifyPinWithLockout(db, 'o', '4826', now)).toEqual({
      kind: 'locked',
      until: now + 300_000,
    });
    expect(await isPinTaken(db, '1357')).toBe(true);
    expect(await isPinTaken(db, '4826', 'o')).toBe(false);
    expect(await isPinTaken(db, '9999')).toBe(false);
  });
});

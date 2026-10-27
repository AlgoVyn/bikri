import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncAttention } from '../data/home.ts';
import { setKv } from '../data/kv.ts';
import { dropTestDbs } from '../data/testDb.ts';
import { readyDb } from '../data/testShop.ts';
import { writeAction } from '../data/write.ts';
import { importUnsynced, previewUnsynced } from '../settings/DevicesPage.tsx';
import { useSession } from '../state/session.ts';
import { FakeServer } from './fakeServer.ts';
import {
  normaliseSigninCode,
  OwnerSigninRequired,
  ownerSessionValid,
  shopRequest,
  startOwnerSignin,
  useOwnerSession,
  verifyOwnerSignin,
} from './shopApi.ts';

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
  useOwnerSession.getState().clear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await dropTestDbs();
});

describe('owner sign-in client (T-028)', () => {
  it('normalises Urdu and Arabic digits', () => {
    expect(normaliseSigninCode('۱۲۳ ٤٥٦ 7')).toBe('123456');
    expect(normaliseSigninCode('12-34')).toBe('1234');
  });

  it('sends staff and session headers; keeps the session in memory and drops it on lock', async () => {
    const db = await readyDb('own');
    await setKv(db, 'device_token', 'tok');
    server.override = (req) => {
      if (req.path === '/shop/owner-signin/start')
        return {
          json: {
            code_id: 'c1',
            expires_at: Date.now() + 600_000,
            email_hint: 'a***@x.com',
          },
        };
      if (req.path === '/shop/owner-signin/verify')
        return {
          json: { session: 'sess', expires_at: Date.now() + 3_600_000 },
        };
      if (req.path === '/shop/devices')
        return req.headers.get('x-bikri-owner-session') === 'sess'
          ? { json: { devices: [] } }
          : { status: 401, json: { error: { code: 'OWNER_SIGNIN_REQUIRED' } } };
      return undefined;
    };
    await expect(shopRequest(db, 'st1', '/devices')).rejects.toBeInstanceOf(
      OwnerSigninRequired,
    );
    const start = await startOwnerSignin(db, 'st1');
    expect(start.email_hint).toBe('a***@x.com');
    expect(server.log.at(-1)?.headers.get('x-bikri-staff')).toBe('st1');
    await verifyOwnerSignin(db, 'st1', start.code_id, '۱۲۳۴۵۶');
    expect((server.log.at(-1)?.body as { code: string }).code).toBe('123456');
    expect(ownerSessionValid('st1')).toBe(true);
    expect(ownerSessionValid('st2')).toBe(false);
    expect(await shopRequest(db, 'st1', '/devices')).toEqual({ devices: [] });
    useSession
      .getState()
      .unlock({ staff_id: 'st1', role: 'owner', unlocked_at: 1 });
    useSession.getState().lock();
    expect(ownerSessionValid('st1')).toBe(false);
    server.override = () => ({
      status: 500,
      json: { error: { code: 'INTERNAL' } },
    });
    await expect(shopRequest(db, 'st1', '/devices')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});

describe('import unsynced ops (03 §8)', () => {
  const file = (tenant: string, n = 3) => ({
    format: 'bikri-unsynced',
    version: 2,
    tenant_id: tenant,
    device_id: 'd-old',
    ops: Array.from({ length: n }, (_, i) => ({
      tbl: i % 2 ? 'payments' : 'sales',
      kind: 'insert',
      created_at: 1000 + i,
      row: { total: 500, amount: 200 },
    })),
  });
  it('previews and refuses other shops and junk', () => {
    expect(previewUnsynced('nope', 't')).toEqual({ error: 'invalid' });
    expect(previewUnsynced('{"format":"x"}', 't')).toEqual({
      error: 'invalid',
    });
    expect(previewUnsynced(JSON.stringify(file('other')), 't')).toEqual({
      error: 'other_shop',
    });
    const p = previewUnsynced(JSON.stringify(file('t')), 't');
    expect(p).toMatchObject({
      count: 3,
      from: 1000,
      to: 1002,
      sales: 1000,
      payments: 200,
    });
  });
  it('posts in chunks of 200 and counts results', async () => {
    const db = await readyDb('imp');
    await setKv(db, 'device_token', 'tok');
    useOwnerSession.getState().set('sess', Date.now() + 1000, 'st1');
    server.override = (req) =>
      req.path === '/shop/import-ops'
        ? {
            json: {
              results: (req.body as { ops: unknown[] }).ops.map((_, i) => ({
                result: i === 0 ? 'rejected' : 'applied',
              })),
            },
          }
        : undefined;
    const seen: number[] = [];
    const out = await importUnsynced(db, 'st1', file(db.tenantId, 450), (d) =>
      seen.push(d),
    );
    expect(seen).toEqual([200, 400, 450]);
    expect(out).toEqual({ applied: 447, rejected: 3 });
  });
});

describe('Home sync warnings (T-037)', () => {
  it('warns at 7 and 25 days, on old pending ops and on a wrong clock', async () => {
    const db = await readyDb('warn');
    const now = Date.UTC(2026, 5, 30);
    expect(await syncAttention(db, now)).toEqual([]);
    await setKv(db, 'device_token', 'tok');
    await setKv(db, 'last_sync_at', now - 8 * 86_400_000);
    expect(await syncAttention(db, now)).toEqual([
      { kind: 'sync_stale', days: 8, severe: false },
    ]);
    await setKv(db, 'last_sync_at', now - 26 * 86_400_000);
    await setKv(db, 'clock_skew_ms', 10 * 60_000);
    await writeAction(db, (w) => w.create('categories', { name_en: 'X' }), {
      now: now - 2 * 86_400_000,
    });
    const kinds = (await syncAttention(db, now)).map((i) => i.kind);
    expect(kinds).toEqual(['clock_wrong', 'sync_stale', 'sync_pending_old']);
    expect((await syncAttention(db, now))[1]).toMatchObject({ severe: true });
  });
});

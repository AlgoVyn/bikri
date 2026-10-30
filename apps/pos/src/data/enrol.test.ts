import { deleteTenantDb, openTenantDb } from '@bikri/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServer } from '../sync/fakeServer.ts';
import { fetchRemoteFile, uploadQueued } from '../sync/files.ts';
import { isReadOnly } from '../sync/status.ts';
import {
  CODE_RE,
  defaultDeviceName,
  enrolDevice,
  formatCode,
  leaveShop,
  markUnsyncedExported,
  normaliseCodeInput,
  UnsyncedOpsError,
  unexportedOps,
  unsyncedExport,
} from './enrol.ts';
import { getKv, setKv } from './kv.ts';
import { activeTenantId, setActiveTenantId } from './tenant.ts';
import { dropTestDbs } from './testDb.ts';
import { readyDb } from './testShop.ts';
import { onLocalWrite, ReadOnlyError, writeAction } from './write.ts';

let server: FakeServer;
const enrolResponse = (
  tenant: string,
  status: 'active' | 'read_only' = 'active',
) => ({
  tenant: { id: tenant, display_name: 'Hall Road Mobiles' },
  device: {
    id: 'd-new',
    name: 'Counter 2',
    branch_id: 'br-1',
    device_code: 'B',
    is_admin: false,
    kind: 'till',
    last_invoice_seq: 7,
  },
  token: 'secret-token',
  shop_setup_completed: true,
  tenant_status: { status, since: status === 'read_only' ? 5 : null },
  support: null,
  poll_after_ms: 30_000,
});

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
  localStorage.clear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await dropTestDbs();
  await deleteTenantDb('t-enrol');
  localStorage.clear();
});

describe('code helpers', () => {
  it('normalises lowercase and dashed input (screens/02 AC 3)', () => {
    expect(normaliseCodeInput('abcd-efgh')).toBe('ABCDEFGH');
    expect(normaliseCodeInput(' ab cd ef gh ij')).toBe('ABCDEFGH');
    expect(formatCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(formatCode('abc')).toBe('ABC');
    expect(CODE_RE.test('ABCDEFGH')).toBe(true);
    expect(CODE_RE.test('ABCDEFG0')).toBe(false);
  });
  it('names the device from the user agent', () => {
    expect(
      defaultDeviceName('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537'),
    ).toBe('Chrome on Windows');
    expect(
      defaultDeviceName(
        'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari',
      ),
    ).toBe('Chrome on Android');
    expect(
      defaultDeviceName('Mozilla/5.0 (iPhone) Version/17 Safari/604'),
    ).toBe('Safari on iOS');
    expect(defaultDeviceName('Firefox/120')).toBe('Firefox');
  });
});

describe('enrolDevice', () => {
  it('stores the token in the tenant database only and sets the active shop', async () => {
    server.override = (req) =>
      req.path === '/devices/enrol'
        ? { status: 201, json: enrolResponse('t-enrol', 'read_only') }
        : undefined;
    const { db, res } = await enrolDevice('abcd-efgh', 'Counter 2');
    const body = server.log.at(-1)?.body as {
      code: string;
      app_version: string;
    };
    expect(body.code).toBe('ABCDEFGH');
    expect(body.app_version).toBeTruthy();
    expect(res.tenant.display_name).toBe('Hall Road Mobiles');
    expect(db.tenantId).toBe('t-enrol');
    expect(activeTenantId({})).toBe('t-enrol');
    expect(await getKv(db, 'device_token', null)).toBe('secret-token');
    expect(await getKv(db, 'invoice_seq', 0)).toBe(7);
    expect(await getKv(db, 'poll_after_ms', 0)).toBe(30_000);
    expect(await isReadOnly(db)).toBe(true);
    // screens/02 AC 5: never in localStorage.
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) ?? '';
      expect(localStorage.getItem(k)).not.toContain('secret-token');
    }
    db.close();
  });

  it('a re-enrolment starts from a fresh database', async () => {
    const old = openTenantDb('t-enrol');
    await setKv(old, 'revoked', { at: 1 });
    old.close();
    server.override = (req) =>
      req.path === '/devices/enrol'
        ? { status: 201, json: enrolResponse('t-enrol') }
        : undefined;
    const { db } = await enrolDevice('ABCDEFGH', 'x');
    expect(await getKv(db, 'revoked', null)).toBeNull();
    db.close();
  });

  it('refuses to replace a shop with unsynced changes', async () => {
    const old = openTenantDb('t-busy');
    setActiveTenantId('t-busy');
    await writeAction(old, (w) => w.create('categories', { name_en: 'X' }));
    old.close();
    await expect(enrolDevice('ABCDEFGH', 'x')).rejects.toBeInstanceOf(
      UnsyncedOpsError,
    );
    expect(server.log.some((entry) => entry.path === '/devices/enrol')).toBe(
      false,
    );
  });

  it('removes the previous shop database when enrolling into another shop', async () => {
    const old = openTenantDb('t-old');
    await setKv(old, 'secret', 'old-shop');
    old.close();
    setActiveTenantId('t-old');
    server.override = (req) =>
      req.path === '/devices/enrol'
        ? { status: 201, json: enrolResponse('t-enrol') }
        : undefined;
    const { db } = await enrolDevice('ABCDEFGH', 'x');
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain('bikri-t-old');
    db.close();
  });

  it('surfaces API errors with their code', async () => {
    server.override = () => ({
      status: 400,
      json: { error: { code: 'BAD_ENROLMENT_CODE', message: 'nope' } },
    });
    await expect(enrolDevice('ABCDEFGH', 'x')).rejects.toMatchObject({
      code: 'BAD_ENROLMENT_CODE',
    });
    expect(activeTenantId({})).toBeNull();
  });
});

describe('leave this shop', () => {
  it('is blocked by unsynced ops until they are exported (D-073)', async () => {
    const db = await readyDb('leave');
    setActiveTenantId(db.tenantId);
    const cat = await writeAction(db, (w) =>
      w.create('categories', { name_en: 'X' }),
    );
    expect(await unexportedOps(db)).toBe(1);
    await expect(leaveShop(db)).rejects.toBeInstanceOf(UnsyncedOpsError);
    const file = await unsyncedExport(db, Date.UTC(2026, 0, 2, 3, 4));
    expect(file.data.format).toBe('bikri-unsynced');
    expect(file.data.ops).toHaveLength(1);
    expect(file.data.ops[0]).not.toHaveProperty('seq');
    expect(file.filename).toMatch(/^bikri-unsynced-.+\.json$/);
    await markUnsyncedExported(db);
    expect(await unexportedOps(db)).toBe(0);
    // A coalesced edit changes the exported row without changing its sequence.
    await writeAction(db, (w) =>
      w.update('categories', String(cat.id), { name_en: 'X2' }),
    );
    expect(await unexportedOps(db)).toBe(1);
    // A later write needs a new export.
    await writeAction(db, (w) => w.create('categories', { name_en: 'Y' }));
    expect(await unexportedOps(db)).toBe(2);
    // A marker written by an older app version has no fingerprint; sequence still works.
    await setKv(db, 'unsynced_exported', {
      at: 1,
      seq: Number((await db.outbox.orderBy('seq').last())?.seq ?? 0),
    });
    expect(await unexportedOps(db)).toBe(0);
    await markUnsyncedExported(db);
    await leaveShop(db);
    expect(localStorage.getItem('bikri.active_tenant')).toBeNull();
    const names = await indexedDB.databases();
    expect(names.map((d) => d.name)).not.toContain(`bikri-${db.tenantId}`);
  });
});

describe('read-only guard and write listeners (T-027)', () => {
  it('blocks local writes in a read-only shop unless allowed', async () => {
    const db = await readyDb('ro');
    const seen: number[] = [];
    const off = onLocalWrite((n) => seen.push(n));
    await writeAction(db, (w) => w.create('categories', { name_en: 'A' }));
    await setKv(db, 'tenant_status', {
      status: 'read_only',
      since: 1,
      learned_at: 2,
    });
    await expect(
      writeAction(db, (w) => w.create('categories', { name_en: 'B' })),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    await writeAction(db, (w) => w.create('categories', { name_en: 'C' }), {
      allowReadOnly: true,
    });
    await writeAction(db, async () => undefined, { allowReadOnly: true });
    off();
    expect(seen).toEqual([1, 1]);
    expect(await db.categories.count()).toBeGreaterThanOrEqual(2);
  });
});

describe('file queue (T-033)', () => {
  it('uploads pending files, drops sent ones and fails rejected ones', async () => {
    const db = await readyDb('files');
    await setKv(db, 'device_token', 'tok');
    const blob = new Blob(['img'], { type: 'image/webp' });
    await db.file_queue.bulkAdd([
      {
        kind: 'product_image',
        target_id: '01J0000000000000000000000A',
        blob,
        sha256: 'a'.repeat(64),
        status: 'pending',
      },
      {
        kind: 'logo',
        target_id: 'ignored',
        blob,
        sha256: 'b'.repeat(64),
        status: 'pending',
      },
    ]);
    server.override = (req) => {
      if (req.path.startsWith('/files/product_image/'))
        return { status: 201, json: { key: 'k' } };
      if (req.path.startsWith('/files/logo/'))
        return {
          status: 415,
          json: { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } },
        };
      return undefined;
    };
    expect(await uploadQueued(db)).toBe(1);
    const put = server.log.find((l) =>
      l.path.startsWith('/files/product_image/'),
    );
    expect(put?.method).toBe('PUT');
    expect(put?.path).toBe(
      `/files/product_image/01J0000000000000000000000A/${'a'.repeat(64)}`,
    );
    expect(put?.headers.get('authorization')).toBe('Bearer tok');
    expect(
      server.log.some((l) => l.path === `/files/logo/shop/${'b'.repeat(64)}`),
    ).toBe(true);
    const left = await db.file_queue.toArray();
    expect(left).toHaveLength(1);
    expect(left[0]?.status).toBe('failed');
  });

  it('keeps files pending on 5xx and offline, and skips without a token', async () => {
    const db = await readyDb('files2');
    const blob = new Blob(['img'], { type: 'image/webp' });
    await db.file_queue.add({
      kind: 'logo',
      target_id: 'shop',
      blob,
      sha256: 'c'.repeat(64),
      status: 'pending',
    });
    expect(await uploadQueued(db)).toBe(0);
    expect(server.log).toHaveLength(0);
    await setKv(db, 'device_token', 'tok');
    server.override = () => ({
      status: 503,
      json: { error: { code: 'D1_LIMIT' } },
    });
    await expect(uploadQueued(db)).rejects.toMatchObject({ code: 'D1_LIMIT' });
    server.online = false;
    await expect(uploadQueued(db)).rejects.toThrow();
    expect((await db.file_queue.toArray())[0]?.status).toBe('pending');
  });

  it('downloads a missing file with the token', async () => {
    const db = await readyDb('files3');
    expect(await fetchRemoteFile(db, 'products/x/y.webp')).toBeNull();
    await setKv(db, 'device_token', 'tok');
    server.override = (req) =>
      req.path === '/files/products/x/y.webp'
        ? { status: 200, json: { ok: 1 } }
        : { status: 404, json: {} };
    expect(await fetchRemoteFile(db, 'products/x/y.webp')).not.toBeNull();
    expect(await fetchRemoteFile(db, 'products/x/z.webp')).toBeNull();
    server.online = false;
    expect(await fetchRemoteFile(db, 'products/x/y.webp')).toBeNull();
  });
});

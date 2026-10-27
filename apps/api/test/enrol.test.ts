import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  codeFromIndex,
  indexOfCode,
  nextDeviceCode,
} from '../src/auth/deviceCodes.ts';
import { resetEnrolLimit } from '../src/auth/enrolLimit.ts';
import { api, json, seedShop, setStatus } from './helpers/fixtures.ts';

type EnrolResponse = {
  tenant: { id: string; display_name: string };
  device: {
    id: string;
    device_code: string;
    is_admin: boolean;
    kind: string;
    last_invoice_seq: number;
  };
  token: string;
  shop_setup_completed: boolean;
};

const enrolBody = (code: string) => ({
  code,
  user_agent: 'test',
  app_version: '0.1.0',
});

beforeEach(() => resetEnrolLimit());

describe('device codes', () => {
  it('counts A..Z then AA', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(codeFromIndex)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
    for (let i = 0; i < 800; i += 1)
      expect(indexOfCode(codeFromIndex(i))).toBe(i);
    expect(nextDeviceCode(['A', 'C'])).toBe('D');
    expect(nextDeviceCode([])).toBe('A');
  });
});

describe('POST /api/devices/enrol', () => {
  it('enrols with the owner pairing code into its tenant (I9), once', async () => {
    const shop = await seedShop('Enrol One');
    const res = await api('/devices/enrol', {
      method: 'POST',
      json: enrolBody(shop.ownerCode),
    });
    expect(res.status).toBe(201);
    const body = await json<EnrolResponse>(res);
    expect(body.tenant.id).toBe(shop.tenantId);
    expect(body.device).toMatchObject({
      device_code: 'C',
      is_admin: true,
      kind: 'till',
      last_invoice_seq: 0,
    });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.shop_setup_completed).toBe(true);
    const stored = await env.DB.prepare(
      'SELECT token_hash FROM devices WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, body.device.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(body.token);
    const log = await env.DB.prepare(
      "SELECT row_json FROM change_log WHERE tenant_id = ?1 AND tbl = 'devices' AND row_id = ?2",
    )
      .bind(shop.tenantId, body.device.id)
      .first<{ row_json: string }>();
    expect(JSON.parse(log?.row_json ?? '{}')).not.toHaveProperty('token_hash');
    expect(JSON.parse(log?.row_json ?? '{}')).not.toHaveProperty('tenant_id');

    const again = await api('/devices/enrol', {
      method: 'POST',
      json: enrolBody(shop.ownerCode),
    });
    expect(again.status).toBe(400);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe(
      'BAD_ENROLMENT_CODE',
    );
  });

  it('accepts the code without dash and in lower case', async () => {
    const shop = await seedShop('Enrol Case');
    const res = await api('/devices/enrol', {
      method: 'POST',
      json: enrolBody(shop.ownerCode.replace('-', '').toLowerCase()),
    });
    expect(res.status).toBe(201);
  });

  it('uses the typed device name when given, else the name on the code (D-107)', async () => {
    const shop = await seedShop('Enrol Name');
    const res = await api('/devices/enrol', {
      method: 'POST',
      json: { ...enrolBody(shop.ownerCode), device_name: '  Front counter ' },
    });
    expect(res.status).toBe(201);
    const body = await json<EnrolResponse & { device: { name: string } }>(res);
    expect(body.device.name).toBe('Front counter');
    const bad = await api('/devices/enrol', {
      method: 'POST',
      json: { ...enrolBody(shop.ownerCode), device_name: 'x'.repeat(41) },
    });
    expect(bad.status).toBe(400);
  });

  it('refuses unknown and expired codes, and rate-limits failures per IP', async () => {
    const shop = await seedShop('Enrol Expired');
    await env.DB.prepare(
      'UPDATE enrolment_codes SET expires_at = 1 WHERE tenant_id = ?1',
    )
      .bind(shop.tenantId)
      .run();
    const expired = await api('/devices/enrol', {
      method: 'POST',
      json: enrolBody(shop.ownerCode),
    });
    expect(expired.status).toBe(400);
    for (let i = 0; i < 4; i += 1) {
      const r = await api('/devices/enrol', {
        method: 'POST',
        json: enrolBody('2345-6789'),
      });
      expect(r.status).toBe(400);
    }
    const limited = await api('/devices/enrol', {
      method: 'POST',
      json: enrolBody('2345-6789'),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
  });

  it('refuses suspended and deleting shops; read-only shops can enrol', async () => {
    for (const [status, code] of [
      ['suspended', 403],
      ['deleting', 403],
      ['maintenance', 503],
      ['read_only', 201],
    ] as const) {
      const shop = await seedShop(`Enrol ${status}`, { status });
      const res = await api('/devices/enrol', {
        method: 'POST',
        json: enrolBody(shop.ownerCode),
      });
      expect(res.status, status).toBe(code);
    }
  });

  it('validates the body', async () => {
    const res = await api('/devices/enrol', {
      method: 'POST',
      json: { user_agent: 'x' },
    });
    expect(res.status).toBe(400);
  });
});

describe('deviceAuth, tenantGate and /api/me', () => {
  it('returns own tenant and device only (I10)', async () => {
    const a = await seedShop('Me A');
    const b = await seedShop('Me B');
    for (const [shop, dev] of [
      [a, a.admin],
      [a, a.till],
      [b, b.admin],
      [b, b.till],
    ] as const) {
      const res = await api('/me', {
        token: dev.token,
        headers: { 'x-bikri-pending': '3;1700000000000' },
      });
      expect(res.status).toBe(200);
      const body = await json<{
        tenant: { id: string };
        device: {
          id: string;
          is_admin: boolean;
          kind: string;
          revoked: boolean;
        };
        tenant_status: unknown;
        support: unknown;
        poll_after_ms: number;
        shop_setup_completed: boolean;
        latest_seq: number;
      }>(res);
      expect(body.tenant.id).toBe(shop.tenantId);
      expect(body.device.id).toBe(dev.id);
      expect(body.device.kind).toBe('till');
      expect(body.tenant_status).toEqual({ status: 'active', since: null });
      expect(body.support).toBeNull();
      expect(body.poll_after_ms).toBe(60000);
      expect(body.shop_setup_completed).toBe(true);
      expect(body.latest_seq).toBeGreaterThan(0);
    }
    const seen = await env.DB.prepare(
      'SELECT pending_ops, oldest_pending_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, a.till.id)
      .first();
    expect(seen).toEqual({ pending_ops: 3, oldest_pending_at: 1700000000000 });
  });

  it('401 without, with a bad or with a revoked token', async () => {
    expect((await api('/me')).status).toBe(401);
    expect((await api('/me', { token: 'x'.repeat(43) })).status).toBe(401);
    const shop = await seedShop('Revoked');
    await env.DB.prepare(
      'UPDATE devices SET revoked_at = 1 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, shop.till.id)
      .run();
    const res = await api('/me', { token: shop.till.token });
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      'DEVICE_REVOKED',
    );
  });

  it('suspended and deleting tenants get 403 TENANT_SUSPENDED on device endpoints (I15)', async () => {
    const s = await seedShop('Suspended', { status: 'suspended' });
    const d = await seedShop('Deleting', { status: 'deleting' });
    for (const shop of [s, d]) {
      for (const path of ['/me', '/sync/pull?since=0', '/sync/snapshot']) {
        const res = await api(path, { token: shop.admin.token });
        expect(res.status, path).toBe(403);
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
          'TENANT_SUSPENDED',
        );
      }
    }
  });

  it('maintenance answers 503 with Retry-After', async () => {
    const m = await seedShop('Maint');
    await setStatus(m.tenantId, 'maintenance');
    const res = await api('/me', { token: m.admin.token });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
  });

  it('read-only: /me carries the status and sets read_only_seen_at once', async () => {
    const r = await seedShop('ReadOnly', { status: 'read_only' });
    const res = await api('/me', { token: r.till.token });
    const body = await json<{
      tenant_status: { status: string; since: number };
    }>(res);
    expect(body.tenant_status.status).toBe('read_only');
    expect(body.tenant_status.since).toBeGreaterThan(0);
    const row = await env.DB.prepare(
      'SELECT read_only_seen_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(r.tenantId, r.till.id)
      .first<{ read_only_seen_at: number }>();
    expect(row?.read_only_seen_at).toBeGreaterThan(0);
  });
});

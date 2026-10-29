import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { testMail, testOutbox } from '../src/auth/mailer.ts';
import {
  addSupportDevice,
  api,
  IDS,
  json,
  seedShop,
  setStatus,
} from './helpers/fixtures.ts';
import { saleOps } from './helpers/ops.ts';
import {
  lastCode,
  ownerHeaders,
  ownerSession,
  shopApi,
  startSignin,
} from './helpers/shop.ts';

type Err = { error: { code: string; details?: Record<string, unknown> } };
const n = async (sql: string, ...p: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...p)
        .first<{ n: number }>()
    )?.n ?? 0,
  );
const auditCount = (tenantId: string, action: string) =>
  n(
    'SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?1 AND action = ?2',
    tenantId,
    action,
  );

beforeEach(() => {
  testMail.fail = false;
});

describe('owner email sign-in (T-028, 05 §3.2)', () => {
  it('start emails the owner only, verify returns a 12 h session, single use', async () => {
    const a = await seedShop('Sign A', { ownerEmail: 'ali@gmail.com' });
    const res = await startSignin(a);
    expect(res.status).toBe(200);
    const start = await json<{
      code_id: string;
      expires_at: number;
      email_hint: string;
    }>(res);
    expect(start.email_hint).toBe('a***@gmail.com');
    expect(start.expires_at - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const mail = testOutbox.at(-1);
    expect(mail?.to).toBe('ali@gmail.com');
    expect(mail?.subject).toBe('Your Bikri sign-in code');
    expect(mail?.subject).not.toMatch(/\d{6}/);
    expect(mail?.text).toContain('Sign A');
    expect(mail?.text).toContain('10');
    const code = lastCode('ali@gmail.com');
    const wrong = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: a.admin.token,
      headers: ownerHeaders(),
      json: {
        code_id: start.code_id,
        code: code === '000000' ? '111111' : '000000',
      },
    });
    expect(wrong.status).toBe(400);
    expect((await json<Err>(wrong)).error).toMatchObject({
      code: 'BAD_SIGNIN_CODE',
      details: { tries_left: 4 },
    });
    const ok = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: a.admin.token,
      headers: ownerHeaders(),
      json: { code_id: start.code_id, code },
    });
    expect(ok.status).toBe(200);
    const s = await json<{ session: string; expires_at: number }>(ok);
    expect(s.expires_at - Date.now()).toBeGreaterThan(11.9 * 3_600_000);
    const reuse = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: a.admin.token,
      headers: ownerHeaders(),
      json: { code_id: start.code_id, code },
    });
    expect((await json<Err>(reuse)).error.details).toEqual({ tries_left: 0 });
    expect(await auditCount(a.tenantId, 'owner_signin')).toBe(1);
    // The session works for shop admin calls.
    expect((await shopApi(a, s.session, '/shop/devices')).status).toBe(200);
  });

  it('5 wrong tries kill the code; 60 s cooldown; expired code', async () => {
    const a = await seedShop('Sign tries');
    const start = await json<{ code_id: string }>(await startSignin(a));
    const code = lastCode(a.ownerEmail ?? '');
    const other = code === '123456' ? '654321' : '123456';
    for (let i = 4; i >= 0; i -= 1) {
      const r = await api('/shop/owner-signin/verify', {
        method: 'POST',
        token: a.admin.token,
        headers: ownerHeaders(),
        json: { code_id: start.code_id, code: other },
      });
      expect((await json<Err>(r)).error.details).toEqual({ tries_left: i });
    }
    const dead = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: a.admin.token,
      headers: ownerHeaders(),
      json: { code_id: start.code_id, code },
    });
    expect((await json<Err>(dead)).error.details).toEqual({ tries_left: 0 });
    const again = await startSignin(a);
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    // Past the cooldown, an expired code is refused.
    await env.DB.prepare(
      'UPDATE owner_email_codes SET created_at = created_at - 120000 WHERE tenant_id = ?1',
    )
      .bind(a.tenantId)
      .run();
    const s2 = await json<{ code_id: string }>(await startSignin(a));
    await env.DB.prepare(
      'UPDATE owner_email_codes SET expires_at = 1 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, s2.code_id)
      .run();
    const exp = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: a.admin.token,
      headers: ownerHeaders(),
      json: { code_id: s2.code_id, code: lastCode(a.ownerEmail ?? '') },
    });
    expect((await json<Err>(exp)).error).toMatchObject({
      code: 'BAD_SIGNIN_CODE',
      details: { tries_left: 0 },
    });
  });

  it('hourly and daily caps, pause after 3 dead codes, EMAIL_UNAVAILABLE', async () => {
    const a = await seedShop('Sign caps');
    const now = Date.now();
    const insert = (id: string, at: number, attempts = 0) =>
      env.DB.prepare(
        "INSERT INTO owner_email_codes (tenant_id, id, device_id, staff_id, code_hash, attempts, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, 'x', ?5, ?6, ?6 + 600000)",
      )
        .bind(a.tenantId, id, a.till.id, IDS.owner, attempts, at)
        .run();
    for (let i = 0; i < 5; i += 1)
      await insert(`01JC00000000000000000000H${i}`, now - 30 * 60_000 + i);
    expect((await startSignin(a)).status).toBe(429);
    await env.DB.prepare('DELETE FROM owner_email_codes WHERE tenant_id = ?1')
      .bind(a.tenantId)
      .run();
    for (let i = 0; i < 20; i += 1)
      await insert(
        `01JC0000000000000000000D${String(i).padStart(2, '0')}`,
        now - 20 * 3_600_000 + i,
      );
    expect((await json<Err>(await startSignin(a))).error.code).toBe(
      'RATE_LIMITED',
    );
    await env.DB.prepare('DELETE FROM owner_email_codes WHERE tenant_id = ?1')
      .bind(a.tenantId)
      .run();
    for (let i = 0; i < 3; i += 1)
      await insert(`01JC00000000000000000000X${i}`, now - 10 * 60_000 + i, 5);
    const paused = await startSignin(a);
    expect(paused.status).toBe(429);
    expect(Number(paused.headers.get('retry-after'))).toBeGreaterThan(40 * 60);

    const b = await seedShop('Sign mail');
    testMail.fail = true;
    const fail = await startSignin(b);
    expect(fail.status).toBe(503);
    expect((await json<Err>(fail)).error.code).toBe('EMAIL_UNAVAILABLE');
    const none = await seedShop('Sign none', { ownerEmail: null });
    expect((await json<Err>(await startSignin(none))).error.code).toBe(
      'OWNER_EMAIL_MISSING',
    );
  });

  it('shopAdmin: non-admin device 403, manager 403, missing session 401', async () => {
    const a = await seedShop('Gate A');
    const session = await ownerSession(a, a.ownerEmail ?? '');
    const till = await api('/shop/devices', {
      token: a.till.token,
      headers: ownerHeaders(IDS.owner, session),
    });
    expect(till.status).toBe(403);
    const cashier = await api('/shop/devices', {
      token: a.admin.token,
      headers: ownerHeaders(IDS.cashier, session),
    });
    expect(cashier.status).toBe(403);
    const missing = await api('/shop/devices', {
      token: a.admin.token,
      headers: ownerHeaders(),
    });
    expect(missing.status).toBe(401);
    expect((await json<Err>(missing)).error.code).toBe('OWNER_SIGNIN_REQUIRED');
    const tampered = await api('/shop/devices', {
      token: a.admin.token,
      headers: ownerHeaders(IDS.owner, `${session}x`),
    });
    expect(tampered.status).toBe(401);
  });
});

describe('shop admin (T-038, 04 §3.8)', () => {
  it('codes: create (15 min), list, cancel; devices: rename, move branch (new code), admin off, revoke', async () => {
    const a = await seedShop('Admin A');
    const s = await ownerSession(a, a.ownerEmail ?? '');
    const created = await shopApi(a, s, '/shop/enrolment-codes', {
      method: 'POST',
      json: {
        device_name: 'Counter 3',
        branch_id: a.branchId,
        is_admin: false,
      },
    });
    expect(created.status).toBe(201);
    const code = await json<{ code: string; expires_at: number }>(created);
    const list = await json<{ codes: { id: string; device_name: string }[] }>(
      await shopApi(a, s, '/shop/enrolment-codes'),
    );
    expect(list.codes.map((x) => x.device_name)).toContain('Counter 3');
    expect(
      (
        await shopApi(a, s, `/shop/enrolment-codes/${code.code}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await shopApi(a, s, `/shop/enrolment-codes/${code.code}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);

    const renamed = await shopApi(a, s, `/shop/devices/${a.till.id}`, {
      method: 'PATCH',
      json: { name: 'Front' },
    });
    expect(
      (await json<{ device: { name: string } }>(renamed)).device.name,
    ).toBe('Front');
    // Move to a new branch → a new device code there.
    const branch2 = '01JC0000000000000000000BR2';
    await env.DB.prepare(
      "INSERT INTO branches (tenant_id, id, name, bill_prefix, created_at, updated_at) VALUES (?1, ?2, 'Second', 'SEC', 1, 1)",
    )
      .bind(a.tenantId, branch2)
      .run();
    const moved = await json<{
      device: { branch_id: string; device_code: string };
    }>(
      await shopApi(a, s, `/shop/devices/${a.till.id}`, {
        method: 'PATCH',
        json: { branch_id: branch2 },
      }),
    );
    expect(moved.device).toMatchObject({
      branch_id: branch2,
      device_code: 'A',
    });
    // Last admin cannot lose admin nor be revoked by the shop.
    const off = await shopApi(a, s, `/shop/devices/${a.admin.id}`, {
      method: 'PATCH',
      json: { is_admin: false },
    });
    expect((await json<Err>(off)).error.code).toBe('LAST_ADMIN_DEVICE');
    const rev = await shopApi(a, s, `/shop/devices/${a.admin.id}/revoke`, {
      method: 'POST',
    });
    expect(rev.status).toBe(409);
    expect(
      (
        await shopApi(a, s, `/shop/devices/${a.till.id}/revoke`, {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(
      (await json<Err>(await api('/me', { token: a.till.token }))).error.code,
    ).toBe('DEVICE_REVOKED');
    for (const action of [
      'device_enrol_code',
      'device_change',
      'device_revoke',
    ]) {
      expect(await auditCount(a.tenantId, action), action).toBeGreaterThan(0);
    }
  });

  it("15: import a revoked till's unsynced ops", async () => {
    const a = await seedShop('Import A');
    const s = await ownerSession(a, a.ownerEmail ?? '');
    const early = await shopApi(a, s, '/shop/import-ops', {
      method: 'POST',
      json: { device_id: a.till.id, ops: saleOps(a, a.till, 1) },
    });
    expect(early.status).toBe(403);
    expect(
      (
        await shopApi(a, s, `/shop/devices/${a.till.id}/revoke`, {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    const ops = saleOps(a, a.till, 1);
    const imp = await shopApi(a, s, '/shop/import-ops', {
      method: 'POST',
      json: { device_id: a.till.id, ops },
    });
    expect(imp.status).toBe(200);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(1);
    expect(await auditCount(a.tenantId, 'ops_import')).toBe(1);
  });

  it('owner export: 24 h limit, export_id bound to tenant and device, owner_export audit (I22)', async () => {
    const a = await seedShop('Exp A');
    const b = await seedShop('Exp B');
    const sa = await ownerSession(a, a.ownerEmail ?? '');
    const sb = await ownerSession(b, b.ownerEmail ?? '');
    const start = await json<{ export_id: string; tables: { tbl: string }[] }>(
      await shopApi(b, sb, '/shop/export'),
    );
    expect(start.tables.map((t) => t.tbl)).not.toContain('owner_email_codes');
    const page = await json<{ rows: Record<string, unknown>[] }>(
      await shopApi(
        b,
        sb,
        `/shop/export?export_id=${encodeURIComponent(start.export_id)}&tbl=products`,
      ),
    );
    expect(String(page.rows[0]?.name_en)).toBe('Exp B phone');
    expect(page.rows[0]).not.toHaveProperty('tenant_id');
    const devices = await json<{ rows: Record<string, unknown>[] }>(
      await shopApi(
        b,
        sb,
        `/shop/export?export_id=${encodeURIComponent(start.export_id)}&tbl=devices`,
      ),
    );
    expect(devices.rows.every((r) => !('token_hash' in r))).toBe(true);
    expect((await shopApi(b, sb, '/shop/export')).status).toBe(429);
    // A's limit is independent; an export_id from A is refused on B.
    const aStart = await json<{ export_id: string }>(
      await shopApi(a, sa, '/shop/export'),
    );
    const cross = await shopApi(
      b,
      sb,
      `/shop/export?export_id=${encodeURIComponent(aStart.export_id)}&tbl=products`,
    );
    expect(cross.status).toBe(400);
    expect(await auditCount(b.tenantId, 'owner_export')).toBe(1);
    expect(await auditCount(a.tenantId, 'owner_export')).toBe(1);
  });

  it('read-only shop: import and acknowledge 403 TENANT_READ_ONLY; device list still works', async () => {
    const a = await seedShop('RO admin');
    const s = await ownerSession(a, a.ownerEmail ?? '');
    await setStatus(a.tenantId, 'read_only');
    expect(
      (
        await json<Err>(
          await shopApi(
            a,
            s,
            '/shop/conflicts/01JC00000000000000000000C1/acknowledge',
            { method: 'POST' },
          ),
        )
      ).error.code,
    ).toBe('TENANT_READ_ONLY');
    expect(
      (
        await shopApi(a, s, '/shop/import-ops', {
          method: 'POST',
          json: { device_id: a.till.id, ops: saleOps(a, a.till, 1) },
        })
      ).status,
    ).toBe(403);
    expect((await shopApi(a, s, '/shop/devices')).status).toBe(200);
    expect((await shopApi(a, s, '/shop/export')).status).toBe(200);
  });

  it('conflict acknowledge', async () => {
    const a = await seedShop('Ack');
    const s = await ownerSession(a, a.ownerEmail ?? '');
    await env.DB.prepare(
      "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) VALUES (?1, '01JC00000000000000000000C1', '01JC00000000000000000000C2', 'sales', 'x', 'over_refund', '{}', 'needs_owner', 1)",
    )
      .bind(a.tenantId)
      .run();
    expect(
      (
        await shopApi(
          a,
          s,
          '/shop/conflicts/01JC00000000000000000000C1/acknowledge',
          { method: 'POST' },
        )
      ).status,
    ).toBe(200);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1 AND resolution = 'acknowledged'",
        a.tenantId,
      ),
    ).toBe(1);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1 AND tbl = 'sync_conflicts'",
        a.tenantId,
      ),
    ).toBe(1);
  });
});

describe('isolation I8, I23, I24', () => {
  it("I8: B's admin device cannot touch A's devices, codes, conflicts or imports", async () => {
    const a = await seedShop('I8 A');
    const b = await seedShop('I8 B');
    const sb = await ownerSession(b, b.ownerEmail ?? '');
    await env.DB.prepare(
      'UPDATE devices SET revoked_at = 1 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, a.till.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) VALUES (?1, '01JC00000000000000000000C9', '01JC00000000000000000000C8', 'sales', 'x', 'over_refund', '{}', 'needs_owner', 1)",
    )
      .bind(a.tenantId)
      .run();
    const codeA = await json<{ code: string }>(
      await api(`/admin/tenants/${a.tenantId}/enrolment-codes`, {
        method: 'POST',
        json: { device_name: 'X', grants_admin: false },
      }),
    );
    const calls: [string, RequestInit & { json?: unknown }][] = [
      [
        `/shop/devices/${a.till.id}`,
        { method: 'PATCH', json: { name: 'Hacked' } },
      ],
      [`/shop/devices/${a.admin.id}/revoke`, { method: 'POST' }],
      [
        '/shop/import-ops',
        {
          method: 'POST',
          json: { device_id: a.till.id, ops: saleOps(a, a.till, 1) },
        },
      ],
      [
        '/shop/conflicts/01JC00000000000000000000C9/acknowledge',
        { method: 'POST' },
      ],
      [`/shop/enrolment-codes/${codeA.code}`, { method: 'DELETE' }],
    ];
    for (const [path, init] of calls) {
      const r = await shopApi(b, sb, path, init);
      expect(r.status, path).toBe(404);
    }
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND name = 'Hacked'",
        a.tenantId,
      ),
    ).toBe(0);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND id = ?2 AND revoked_at IS NULL',
        a.tenantId,
        a.admin.id,
      ),
    ).toBe(1);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM sync_conflicts WHERE tenant_id = ?1 AND resolution = 'needs_owner'",
        a.tenantId,
      ),
    ).toBe(1);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM enrolment_codes WHERE tenant_id = ?1 AND used_at IS NULL AND grants_admin = 0',
        a.tenantId,
      ),
    ).toBe(1);
  });

  it("I23: codes go to the shop's own owner; A's code_id or session on B are refused alike", async () => {
    const a = await seedShop('I23 A', { ownerEmail: 'a-owner@example.com' });
    const b = await seedShop('I23 B', { ownerEmail: 'b-owner@example.com' });
    const start = await json<{ code_id: string }>(await startSignin(a));
    expect(testOutbox.at(-1)?.to).toBe('a-owner@example.com');
    const code = lastCode('a-owner@example.com');
    const cross = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: b.admin.token,
      headers: ownerHeaders(),
      json: { code_id: start.code_id, code },
    });
    const unknown = await api('/shop/owner-signin/verify', {
      method: 'POST',
      token: b.admin.token,
      headers: ownerHeaders(),
      json: { code_id: '01JC000000000000000000NONE', code },
    });
    expect(cross.status).toBe(400);
    expect(await cross.json()).toEqual(await unknown.json());
    const sa = await ownerSession(a, 'a-owner@example.com').catch(() => '');
    // The cooldown on A's device blocks a second start within 60 s; use the first code instead.
    const session =
      sa ||
      (
        await json<{ session: string }>(
          await api('/shop/owner-signin/verify', {
            method: 'POST',
            token: a.admin.token,
            headers: ownerHeaders(),
            json: { code_id: start.code_id, code },
          }),
        )
      ).session;
    const onB = await api('/shop/devices', {
      token: b.admin.token,
      headers: ownerHeaders(IDS.owner, session),
    });
    expect((await json<Err>(onB)).error.code).toBe('OWNER_SIGNIN_REQUIRED');
    // B's limits are independent of A's cooldown.
    expect((await startSignin(b)).status).toBe(200);
  });

  it("I24: B's owner cannot end A's support access; A's owner can (support_access_end in A)", async () => {
    const a = await seedShop('I24 A');
    const b = await seedShop('I24 B');
    const started = await api(`/admin/tenants/${a.tenantId}/support-access`, {
      method: 'POST',
      json: { reason: 'Printer', hours: 2 },
    });
    expect(started.status).toBe(201);
    const support = await addSupportDevice(a, Date.now() + 3_600_000);
    const meA = await json<{ support: unknown }>(
      await api('/me', { token: a.till.token }),
    );
    expect(meA.support).toMatchObject({ reason: 'Printer' });
    const meB = await json<{ support: unknown }>(
      await api('/me', { token: b.till.token }),
    );
    expect(meB.support).toBeNull();
    const endB = await api('/shop/support-access/end', {
      method: 'POST',
      token: b.admin.token,
      headers: ownerHeaders(),
    });
    expect(await endB.json()).toEqual({ ended: false });
    expect((await api('/me', { token: support.token })).status).toBe(200);
    const endA = await api('/shop/support-access/end', {
      method: 'POST',
      token: a.admin.token,
      headers: ownerHeaders(),
    });
    expect(await endA.json()).toEqual({ ended: true });
    expect(
      (await json<Err>(await api('/me', { token: support.token }))).error.code,
    ).toBe('DEVICE_REVOKED');
    expect(await auditCount(a.tenantId, 'support_access_start')).toBe(1);
    expect(await auditCount(a.tenantId, 'support_access_end')).toBe(1);
    expect(await auditCount(b.tenantId, 'support_access_end')).toBe(0);
    const row = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE tenant_id = ?1 AND action = 'support_access_end'",
    )
      .bind(a.tenantId)
      .first<{ after_json: string }>();
    expect(JSON.parse(row?.after_json ?? '{}')).toEqual({ ended_by: 'owner' });
    // Operator end when none active → ended false.
    expect(
      await json(
        await api(`/admin/tenants/${a.tenantId}/support-access/end`, {
          method: 'POST',
        }),
      ),
    ).toEqual({ ended: false });
  });
});

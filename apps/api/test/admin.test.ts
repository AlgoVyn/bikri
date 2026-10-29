import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { verifyAccessJwt } from '../src/auth/access.ts';
import { base64url } from '../src/auth/crypto.ts';
import { api, json, seedShop, setStatus } from './helpers/fixtures.ts';
import { op, productRow, pushOk, saleOps } from './helpers/ops.ts';

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
type Err = { error: { code: string } };

describe('accessAuth and sameOrigin (05 §3.1, 01 §5)', () => {
  it('session returns the operator; other emails 403; device tokens are not accepted', async () => {
    expect(await json(await api('/admin/session'))).toEqual({
      email: 'operator@example.com',
    });
    const other = await api('/admin/session', {
      headers: { 'x-test-access-email': 'someone@example.com' },
    });
    expect(other.status).toBe(403);
    const shop = await seedShop('Access');
    // The test bypass is on, so prove a device token alone does not change who you are, and the
    // device API refuses the console identity.
    const viaDevice = await api('/sync/pull?since=0', {
      headers: { 'x-test-access-email': 'operator@example.com' },
    });
    expect(viaDevice.status).toBe(401);
    expect(
      (await api('/admin/tenants', { token: shop.admin.token })).status,
    ).toBe(200);
  });

  it('a cross-origin POST to /admin gets 403; cross-site fetch metadata gets 403', async () => {
    const res = await api('/admin/tenants', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      json: { slug: 'evil-shop', display_name: 'Evil' },
    });
    expect(res.status).toBe(403);
    const site = await api('/admin/tenants', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(site.status).toBe(403);
    // Device POSTs are also origin-checked.
    const enrol = await api('/devices/enrol', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      json: {},
    });
    expect(enrol.status).toBe(403);
  });

  it('verifies RS256 Access JWTs: aud, iss, exp, signature, kid rotation', async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )) as JsonWebKey;
    const team = 'team-x.cloudflareaccess.com';
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return { keys: [{ ...jwk, kid: 'k1' }] };
    };
    const enc = (o: unknown) =>
      base64url(new TextEncoder().encode(JSON.stringify(o)));
    const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
      const head = enc({ alg: 'RS256', kid });
      const body = enc(claims);
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${base64url(new Uint8Array(sig))}`;
    };
    const good = {
      aud: ['aud-1'],
      iss: `https://${team}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      email: 'operator@example.com',
    };
    const opts = { teamDomain: team, aud: 'aud-1', fetcher };
    expect(await verifyAccessJwt(await sign(good), opts)).toBe(
      'operator@example.com',
    );
    expect(
      await verifyAccessJwt(await sign({ ...good, aud: ['other'] }), opts),
    ).toBeNull();
    expect(
      await verifyAccessJwt(
        await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }),
        opts,
      ),
    ).toBeNull();
    expect(
      await verifyAccessJwt(await sign({ ...good, exp: 1 }), opts),
    ).toBeNull();
    const t = await sign(good);
    expect(await verifyAccessJwt(`${t.slice(0, -4)}AAAA`, opts)).toBeNull();
    const before = fetches;
    expect(await verifyAccessJwt(await sign(good, 'k2'), opts)).toBeNull();
    expect(fetches).toBe(before + 1);
  });
});

describe('operator tenants (04 §3.7, screens/19)', () => {
  it('creates a tenant with branch, categories and a 72 h owner code in one batch; SLUG_TAKEN', async () => {
    const slug = `new-shop-${Date.now() % 100000}`;
    const res = await api('/admin/tenants', {
      method: 'POST',
      json: {
        slug,
        display_name: 'New Shop',
        owner_email: 'Owner@Example.com',
      },
    });
    expect(res.status).toBe(201);
    const body = await json<{
      tenant: { id: string; owner_email: string };
      owner_code: { code: string; link: string; expires_at: number };
    }>(res);
    expect(body.tenant.owner_email).toBe('owner@example.com');
    expect(body.owner_code.code).toMatch(
      /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(body.owner_code.link).toContain('/bikri/enrol?code=');
    expect(body.owner_code.expires_at - Date.now()).toBeGreaterThan(
      71 * 3600_000,
    );
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM branches WHERE tenant_id = ?1',
        body.tenant.id,
      ),
    ).toBe(1);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM expense_categories WHERE tenant_id = ?1',
        body.tenant.id,
      ),
    ).toBeGreaterThan(0);
    const dup = await api('/admin/tenants', {
      method: 'POST',
      json: { slug, display_name: 'Again' },
    });
    expect(dup.status).toBe(409);
    expect((await json<Err>(dup)).error.code).toBe('SLUG_TAKEN');
    expect(
      await json(await api(`/admin/slug-available?slug=${slug}`)),
    ).toMatchObject({ available: false });

    // The code enrols exactly one admin device into that tenant.
    const enrol = await api('/devices/enrol', {
      method: 'POST',
      json: {
        code: body.owner_code.code,
        user_agent: 'test',
        app_version: '0.1.0',
      },
    });
    expect(enrol.status).toBe(201);
    const e = await json<{
      tenant: { id: string };
      device: { is_admin: boolean };
    }>(enrol);
    expect(e.tenant.id).toBe(body.tenant.id);
    expect(e.device.is_admin).toBe(true);

    const list = await json<{ tenants: { id: string; devices: number }[] }>(
      await api('/admin/tenants'),
    );
    expect(list.tenants.find((t) => t.id === body.tenant.id)?.devices).toBe(1);
  });

  it('PATCH edits; owner_email change writes a masked owner_email_change in that tenant only', async () => {
    const a = await seedShop('Patch A');
    const b = await seedShop('Patch B');
    const res = await api(`/admin/tenants/${a.tenantId}`, {
      method: 'PATCH',
      json: { owner_email: 'ali@gmail.com', daily_write_budget: 9000 },
    });
    expect(res.status).toBe(200);
    expect(
      (await json<{ tenant: { daily_write_budget: number } }>(res)).tenant
        .daily_write_budget,
    ).toBe(9000);
    expect(await auditCount(a.tenantId, 'owner_email_change')).toBe(1);
    expect(await auditCount(b.tenantId, 'owner_email_change')).toBe(0);
    const row = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE tenant_id = ?1 AND action = 'owner_email_change'",
    )
      .bind(a.tenantId)
      .first<{ after_json: string }>();
    expect(row?.after_json).toContain('a***@gmail.com');
    expect(
      (await api('/admin/tenants/01JBZZZZZZZZZZZZZZZZZZZZZZ')).status,
    ).toBe(404);
  });

  it('status changes need a reason, follow the allowed transitions and audit in the tenant', async () => {
    const a = await seedShop('Status A');
    const b = await seedShop('Status B');
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/read-only`, {
          method: 'POST',
          json: { reason: '' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/read-only`, {
          method: 'POST',
          json: { reason: 'Unpaid' },
        })
      ).status,
    ).toBe(200);
    // The till learns read-only.
    await api('/me', { token: a.till.token });
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND read_only_seen_at IS NOT NULL',
        a.tenantId,
      ),
    ).toBe(1);
    const again = await api(`/admin/tenants/${a.tenantId}/read-only`, {
      method: 'POST',
      json: { reason: 'x' },
    });
    expect((await json<Err>(again)).error.code).toBe('BAD_STATUS_CHANGE');
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/suspend`, {
          method: 'POST',
          json: { reason: 'Gone' },
        })
      ).status,
    ).toBe(200);
    expect((await api('/me', { token: a.till.token })).status).toBe(403);
    expect((await api('/me', { token: b.till.token })).status).toBe(200);
    const re = await api(`/admin/tenants/${a.tenantId}/reactivate`, {
      method: 'POST',
      json: { reason: 'Paid' },
    });
    expect((await json<{ tenant: { status: string } }>(re)).tenant.status).toBe(
      'active',
    );
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND read_only_seen_at IS NOT NULL',
        a.tenantId,
      ),
    ).toBe(0);
    expect(await auditCount(a.tenantId, 'tenant_status_change')).toBe(3);
    expect(await auditCount(b.tenantId, 'tenant_status_change')).toBe(0);
    const detail = await json<{
      status_history: { to: string; reason: string; by: string }[];
    }>(await api(`/admin/tenants/${a.tenantId}`));
    expect(detail.status_history.map((h) => h.to)).toEqual([
      'active',
      'suspended',
      'read_only',
    ]);
    expect(detail.status_history[0]).toMatchObject({
      reason: 'Paid',
      by: 'operator:operator@example.com',
    });

    // Delete: slug must match; devices revoked; 202.
    const bad = await api(`/admin/tenants/${a.tenantId}/delete`, {
      method: 'POST',
      json: { confirm_slug: 'nope', reason: 'x' },
    });
    expect(bad.status).toBe(400);
    const del = await api(`/admin/tenants/${a.tenantId}/delete`, {
      method: 'POST',
      json: { confirm_slug: a.slug, reason: 'Closed' },
    });
    expect(del.status).toBe(202);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND revoked_at IS NULL',
        a.tenantId,
      ),
    ).toBe(0);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND revoked_at IS NULL',
        b.tenantId,
      ),
    ).toBe(2);
  });

  it('codes, device revoke and owner PIN reset write audit rows in that tenant only', async () => {
    const a = await seedShop('Dev A');
    const b = await seedShop('Dev B');
    const code = await api(`/admin/tenants/${a.tenantId}/enrolment-codes`, {
      method: 'POST',
      json: { device_name: 'Counter 3', grants_admin: false },
    });
    expect(code.status).toBe(201);
    const c = await json<{ expires_at: number }>(code);
    expect(c.expires_at - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const devs = await json<{ devices: Record<string, unknown>[] }>(
      await api(`/admin/tenants/${a.tenantId}/devices`),
    );
    expect(devs.devices).toHaveLength(2);
    expect(devs.devices[0]).not.toHaveProperty('token_hash');
    // B's device id under A's path → 404.
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/devices/${b.till.id}/revoke`, {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/devices/${a.till.id}/revoke`, {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(
      (await json<Err>(await api('/me', { token: a.till.token }))).error.code,
    ).toBe('DEVICE_REVOKED');
    expect((await api('/me', { token: b.till.token })).status).toBe(200);
    const pin = await api(`/admin/tenants/${a.tenantId}/reset-owner-pin`, {
      method: 'POST',
      json: {
        staff_id: '01JB0000000000000000000001',
        pin_hash: 'x'.repeat(44),
        pin_salt: 'y'.repeat(24),
        pin_iterations: 150000,
      },
    });
    expect(pin.status).toBe(200);
    const cashier = await api(`/admin/tenants/${a.tenantId}/reset-owner-pin`, {
      method: 'POST',
      json: {
        staff_id: '01JB0000000000000000000002',
        pin_hash: 'x'.repeat(44),
        pin_salt: 'y'.repeat(24),
        pin_iterations: 150000,
      },
    });
    expect(cashier.status).toBe(404);
    for (const action of ['device_enrol_code', 'device_revoke', 'pin_reset']) {
      expect(await auditCount(a.tenantId, action), action).toBe(1);
      expect(await auditCount(b.tenantId, action), action).toBe(0);
    }
    expect(
      await n(
        "SELECT pin_hash = 'h' AS n FROM staff WHERE tenant_id = ?1 AND id = '01JB0000000000000000000001'",
        b.tenantId,
      ),
    ).toBe(1);
  });

  it('import-ops: only a revoked device of that tenant', async () => {
    const a = await seedShop('Imp A');
    const b = await seedShop('Imp B');
    const ops = saleOps(a, a.till, 1);
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/import-ops`, {
          method: 'POST',
          json: { device_id: a.till.id, ops },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/import-ops`, {
          method: 'POST',
          json: { device_id: b.till.id, ops },
        })
      ).status,
    ).toBe(404);
    await api(`/admin/tenants/${a.tenantId}/devices/${a.till.id}/revoke`, {
      method: 'POST',
    });
    const res = await api(`/admin/tenants/${a.tenantId}/import-ops`, {
      method: 'POST',
      json: { device_id: a.till.id, ops },
    });
    expect(res.status).toBe(200);
    const body = await json<{ results: { result: string }[] }>(res);
    expect(body.results.every((r) => r.result === 'applied')).toBe(true);
    expect(await auditCount(a.tenantId, 'ops_import')).toBe(1);
  });
});

describe('operator export and restore (I17, I18)', () => {
  it('I17: export of A returns only A rows and writes operator_export in A only', async () => {
    const a = await seedShop('Exp A');
    const b = await seedShop('Exp B');
    const start = await json<{
      tenant: { id: string };
      tables: { tbl: string; rows: number }[];
    }>(await api(`/admin/tenants/${a.tenantId}/export`));
    expect(start.tenant.id).toBe(a.tenantId);
    const page = await json<{ rows: Record<string, unknown>[] }>(
      await api(`/admin/tenants/${a.tenantId}/export?tbl=products`),
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).not.toHaveProperty('tenant_id');
    expect(String(page.rows[0]?.name_en)).toBe('Exp A phone');
    const devs = await json<{ rows: Record<string, unknown>[] }>(
      await api(`/admin/tenants/${a.tenantId}/export?tbl=devices`),
    );
    expect(devs.rows.every((r) => !('token_hash' in r))).toBe(true);
    expect(await auditCount(a.tenantId, 'operator_export')).toBe(1);
    expect(await auditCount(b.tenantId, 'operator_export')).toBe(0);
  });

  it('I18: restore of A (purge + import) leaves B unchanged and B pushes during maintenance apply', async () => {
    const a = await seedShop('Res A');
    const b = await seedShop('Res B');
    await pushOk(a.till, saleOps(a, a.till, 1));
    // Export A's products and sales.
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const tbl of [
      'shop',
      'staff',
      'categories',
      'products',
      'sales',
      'sale_lines',
      'payments',
      'stock_movements',
    ]) {
      tables[tbl] = (
        await json<{ rows: Record<string, unknown>[] }>(
          await api(
            `/admin/tenants/${a.tenantId}/export?tbl=${tbl}&limit=1000`,
          ),
        )
      ).rows;
    }
    const bCounts = async () => [
      await n(
        'SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?1',
        b.tenantId,
      ),
      await n(
        'SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1',
        b.tenantId,
      ),
    ];
    const before = await bCounts();

    expect(
      (await api(`/admin/tenants/${a.tenantId}/purge`, { method: 'POST' }))
        .status,
    ).toBe(409);
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/maintenance`, {
          method: 'POST',
          json: { on: true },
        })
      ).status,
    ).toBe(200);
    expect((await api('/me', { token: a.till.token })).status).toBe(503);
    // B keeps syncing during A's maintenance.
    await pushOk(b.till, [
      op(
        'products',
        'upsert',
        productRow('01JB0000000000000000000099', { name_en: 'B new' }),
      ),
    ]);
    let remaining = 1;
    while (remaining > 0) {
      const p = await json<{ remaining: number; deleted: number }>(
        await api(`/admin/tenants/${a.tenantId}/purge`, { method: 'POST' }),
      );
      remaining = p.remaining;
    }
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(0);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(2);
    for (const tbl of [
      'shop',
      'staff',
      'categories',
      'products',
      'sales',
      'sale_lines',
      'payments',
      'stock_movements',
    ]) {
      const rows = tables[tbl] ?? [];
      if (rows.length === 0) continue;
      const r = await api(`/admin/tenants/${a.tenantId}/import`, {
        method: 'POST',
        json: { tbl, rows, reason: 'restore drill' },
      });
      expect(r.status, `${tbl}: ${await r.clone().text()}`).toBe(200);
    }
    const epoch = await api(`/admin/tenants/${a.tenantId}/restore-epoch`, {
      method: 'POST',
      json: {
        restore_point_at: Date.now() - 1000,
        reason: 'restore drill',
      },
    });
    expect(epoch.status).toBe(200);
    const off = await json<{ tenant: { status: string } }>(
      await api(`/admin/tenants/${a.tenantId}/maintenance`, {
        method: 'POST',
        json: { on: false },
      }),
    );
    expect(off.tenant.status).toBe('active');
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(1);
    expect(await auditCount(a.tenantId, 'tenant_restore')).toBe(1);
    expect(await auditCount(a.tenantId, 'operator_import')).toBeGreaterThan(0);
    const restoreAudit = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE tenant_id = ?1 AND action = 'tenant_restore' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(a.tenantId)
      .first<{ after_json: string }>();
    expect(JSON.parse(restoreAudit?.after_json ?? '{}')).toMatchObject({
      reason: 'restore drill',
      by: 'operator:operator@example.com',
    });
    const after = await bCounts();
    expect(after[0]).toBe((before[0] ?? 0) + 1);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        b.tenantId,
      ),
    ).toBe(0);
    expect(await auditCount(b.tenantId, 'tenant_restore')).toBe(0);
    await setStatus(a.tenantId, 'active');
  });

  it('usage reports open conflicts per shop without extra requests', async () => {
    const shop = await seedShop('Conflict usage');
    const at = Date.now();
    for (const suffix of ['C1', 'C2']) {
      await env.DB.prepare(
        "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) VALUES (?1, ?2, ?3, 'sales', 'row', 'over_refund', '{}', 'needs_owner', ?4)",
      )
        .bind(
          shop.tenantId,
          `01JC0000000000000000000${suffix}`,
          `01JC0000000000000000000${suffix === 'C1' ? 'D1' : 'D2'}`,
          at,
        )
        .run();
    }
    const usage = await json<{
      open_conflicts: { tenant_id: string; count: number }[];
    }>(await api('/admin/usage'));
    expect(
      usage.open_conflicts.find((row) => row.tenant_id === shop.tenantId),
    ).toEqual({ tenant_id: shop.tenantId, count: 2 });
  });

  it('backups list and download', async () => {
    await env.BACKUPS.put('d1/2026-10-26.sql.gz', 'gz');
    const list = await json<{ objects: { key: string }[] }>(
      await api('/admin/backups'),
    );
    expect(list.objects.map((o) => o.key)).toContain('d1/2026-10-26.sql.gz');
    const dl = await api('/admin/backups/download?key=d1/2026-10-26.sql.gz');
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(dl.headers.get('cache-control')).toBe('no-store');
    expect(await dl.text()).toBe('gz');
    const usage = await json<{ last_backup: { key: string } | null }>(
      await api('/admin/usage'),
    );
    expect(usage.last_backup?.key).toBe('d1/2026-10-26.sql.gz');
  });
});

import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { verifyAccessJwt } from '../src/auth/access.ts';
import { base64url } from '../src/auth/crypto.ts';
import { statusChangeStatements } from '../src/platform/tenantAdmin.ts';
import type { TenantRow } from '../src/types.ts';
import { api, IDS, json, seedShop, setStatus } from './helpers/fixtures.ts';
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
        app_version: '1.0.0',
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

  it('a lost status CAS writes no audit row or device side effect', async () => {
    const a = await seedShop('Status CAS');
    await setStatus(a.tenantId, 'read_only');
    await env.DB.prepare(
      'UPDATE devices SET read_only_seen_at = 1 WHERE tenant_id = ?1',
    )
      .bind(a.tenantId)
      .run();
    const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?1')
      .bind(a.tenantId)
      .first<TenantRow>();
    if (!tenant) throw new Error('tenant missing');
    const statements = statusChangeStatements(
      env,
      tenant,
      'active',
      'Paid',
      'operator:test',
      Date.now(),
    );
    // Another operator wins the transition before this batch runs.
    await setStatus(a.tenantId, 'suspended');
    await env.DB.batch(statements);
    expect(await auditCount(a.tenantId, 'tenant_status_change')).toBe(0);
    const seen = await env.DB.prepare(
      'SELECT read_only_seen_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, a.till.id)
      .first<{ read_only_seen_at: number | null }>();
    expect(seen?.read_only_seen_at).toBe(1);
  });

  it('maintenance returns to the status it was in (read-only and suspended)', async () => {
    const a = await seedShop('Maint return');
    const setStatus = async (path: string) => {
      const res = await api(`/admin/tenants/${a.tenantId}/${path}`, {
        method: 'POST',
        json: { reason: 'drill' },
      });
      expect(res.status).toBe(200);
    };
    const setMaintenance = async (on: boolean) => {
      const res = await api(`/admin/tenants/${a.tenantId}/maintenance`, {
        method: 'POST',
        json: { on },
      });
      expect(res.status).toBe(200);
      return (await json<{ tenant: { status: string } }>(res)).tenant.status;
    };

    await setStatus('read-only');
    await setMaintenance(true);
    expect(await setMaintenance(false)).toBe('read_only');

    await setStatus('reactivate');
    await setStatus('suspend');
    await setMaintenance(true);
    expect(await setMaintenance(false)).toBe('suspended');
  });

  it('a restore purge keeps the audit log, so a read-only shop returns to read-only', async () => {
    const a = await seedShop('Restore status');
    const setMaintenance = async (on: boolean) => {
      const res = await api(`/admin/tenants/${a.tenantId}/maintenance`, {
        method: 'POST',
        json: { on },
      });
      expect(res.status).toBe(200);
      return (await json<{ tenant: { status: string } }>(res)).tenant.status;
    };
    await api(`/admin/tenants/${a.tenantId}/read-only`, {
      method: 'POST',
      json: { reason: 'unpaid' },
    });
    await setMaintenance(true);
    let remaining = 1;
    while (remaining > 0) {
      const p = await json<{ remaining: number }>(
        await api(`/admin/tenants/${a.tenantId}/purge`, { method: 'POST' }),
      );
      remaining = p.remaining;
    }
    expect(
      await auditCount(a.tenantId, 'tenant_status_change'),
    ).toBeGreaterThan(0);
    expect(await setMaintenance(false)).toBe('read_only');
  });

  it('purges self-referencing sales and expenses without rewriting their links first', async () => {
    const shop = await seedShop('Purge refs');
    const firstSale = saleOps(shop, shop.till, 1);
    const secondSale = saleOps(shop, shop.till, 2);
    // Build the reissue link in the insert itself; ledger rows are append-only and
    // cannot be updated by a test (or any other caller) after the fact.
    secondSale[0]!.row = {
      ...secondSale[0]!.row,
      replaces_sale_id: firstSale[0]!.row?.id,
    };
    await pushOk(shop.till, firstSale);
    await pushOk(shop.till, secondSale);
    const sales = await env.DB.prepare(
      'SELECT id, invoice_seq, replaces_sale_id FROM sales WHERE tenant_id = ?1 ORDER BY invoice_seq',
    )
      .bind(shop.tenantId)
      .all<{ id: string; replaces_sale_id: string | null }>();
    expect(sales.results).toHaveLength(2);
    expect(sales.results[1]?.replaces_sale_id).toBe(sales.results[0]?.id);
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO expense_categories (tenant_id, id, code, name_en, created_at, updated_at) VALUES (?1, 'purge-cat', 'purge-cat', 'Purge', ?2, ?2)",
    )
      .bind(shop.tenantId, Date.now())
      .run();
    const expenseId = newId();
    const baseExpense = {
      category_id: 'purge-cat',
      amount: 1000,
      method: 'cash',
      payee: '',
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: day,
      created_at: Date.now(),
    };
    await env.DB.prepare(
      `INSERT INTO expenses (tenant_id, id, category_id, amount, method, payee, note, reverses_id, branch_id, device_id, staff_id, business_date, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11, ?12)`,
    )
      .bind(
        shop.tenantId,
        expenseId,
        baseExpense.category_id,
        baseExpense.amount,
        baseExpense.method,
        baseExpense.payee,
        baseExpense.note,
        baseExpense.branch_id,
        baseExpense.device_id,
        baseExpense.staff_id,
        baseExpense.business_date,
        baseExpense.created_at,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO expenses (tenant_id, id, category_id, amount, method, payee, note, reverses_id, branch_id, device_id, staff_id, business_date, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
      .bind(
        shop.tenantId,
        newId(),
        baseExpense.category_id,
        baseExpense.amount,
        baseExpense.method,
        baseExpense.payee,
        baseExpense.note,
        expenseId,
        baseExpense.branch_id,
        baseExpense.device_id,
        baseExpense.staff_id,
        baseExpense.business_date,
        baseExpense.created_at + 1,
      )
      .run();
    await api(`/admin/tenants/${shop.tenantId}/maintenance`, {
      method: 'POST',
      json: { on: true },
    });
    let remaining = 1;
    while (remaining > 0) {
      const res = await api(`/admin/tenants/${shop.tenantId}/purge`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      remaining = (await json<{ remaining: number }>(res)).remaining;
    }
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
    expect(devs.devices[0]).toMatchObject({ branch_name: 'Main' });
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
        pin_length: 4,
      },
    });
    expect(pin.status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT pin_length FROM staff WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(a.tenantId, '01JB0000000000000000000001')
        .first<{ pin_length: number }>(),
    ).toEqual({ pin_length: 4 });
    const cashier = await api(`/admin/tenants/${a.tenantId}/reset-owner-pin`, {
      method: 'POST',
      json: {
        staff_id: '01JB0000000000000000000002',
        pin_hash: 'x'.repeat(44),
        pin_salt: 'y'.repeat(24),
        pin_iterations: 150000,
        pin_length: 4,
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
      exported_at: number;
      tables: { tbl: string; rows: number }[];
    }>(await api(`/admin/tenants/${a.tenantId}/export`));
    expect(start.tenant.id).toBe(a.tenantId);
    const before = start.exported_at;
    const page = await json<{ rows: Record<string, unknown>[] }>(
      await api(
        `/admin/tenants/${a.tenantId}/export?tbl=products&before=${before}`,
      ),
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).not.toHaveProperty('tenant_id');
    expect(String(page.rows[0]?.name_en)).toBe('Exp A phone');
    const devs = await json<{ rows: Record<string, unknown>[] }>(
      await api(
        `/admin/tenants/${a.tenantId}/export?tbl=devices&before=${before}`,
      ),
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
    const exportCutoff = Date.now();
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
            `/admin/tenants/${a.tenantId}/export?tbl=${tbl}&limit=1000&before=${exportCutoff}`,
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
    const oversized = await api(`/admin/tenants/${a.tenantId}/import`, {
      method: 'POST',
      json: {
        tbl: 'products',
        rows: [
          { id: '01JB0000000000000000000098', name_en: 'x'.repeat(4_001) },
        ],
      },
    });
    expect(oversized.status).toBe(400);
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

  it('restore round-trip keeps sale totals, stock movements and ledger balances', async () => {
    const a = await seedShop('Restore money');
    const now = Date.now();
    const total = 175_000;
    await pushOk(a.till, saleOps(a, a.till, 1, { total, now }));
    await pushOk(a.till, [
      op('stock_movements', 'insert', {
        id: newId(now),
        product_id: IDS.product,
        qty_delta_milli: 10_000,
        reason_code: 'opening',
        ref_type: 'opening',
        ref_id: null,
        unit_cost: 8_000,
        note: '',
        branch_id: a.branchId,
        device_id: a.till.id,
        staff_id: IDS.owner,
        business_date: '2026-10-27',
        created_at: now,
      }),
    ]);
    const snapshot = async () => ({
      sales: await n(
        'SELECT COALESCE(SUM(total), 0) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
      payments: await n(
        'SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE tenant_id = ?1',
        a.tenantId,
      ),
      stock: await n(
        'SELECT COALESCE(SUM(qty_delta_milli), 0) AS n FROM stock_movements WHERE tenant_id = ?1',
        a.tenantId,
      ),
      ledger: await n(
        'SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE tenant_id = ?1',
        a.tenantId,
      ),
    });
    const before = await snapshot();
    expect(before.sales).toBe(total);
    expect(before.payments).toBe(total);
    expect(before.stock).not.toBe(0);
    const exportCutoff = Date.now();
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const tbl of [
      'shop',
      'staff',
      'categories',
      'products',
      'customers',
      'sales',
      'sale_lines',
      'payments',
      'stock_movements',
      'ledger_entries',
    ]) {
      tables[tbl] = (
        await json<{ rows: Record<string, unknown>[] }>(
          await api(
            `/admin/tenants/${a.tenantId}/export?tbl=${tbl}&limit=1000&before=${exportCutoff}`,
          ),
        )
      ).rows;
    }
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/maintenance`, {
          method: 'POST',
          json: { on: true },
        })
      ).status,
    ).toBe(200);
    let remaining = 1;
    while (remaining > 0) {
      const purged = await json<{ remaining: number }>(
        await api(`/admin/tenants/${a.tenantId}/purge`, { method: 'POST' }),
      );
      remaining = purged.remaining;
    }
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(0);
    for (const tbl of [
      'shop',
      'staff',
      'categories',
      'products',
      'customers',
      'sales',
      'sale_lines',
      'payments',
      'stock_movements',
      'ledger_entries',
    ]) {
      const rows = tables[tbl] ?? [];
      if (rows.length === 0) continue;
      const imported = await api(`/admin/tenants/${a.tenantId}/import`, {
        method: 'POST',
        json: { tbl, rows, reason: 'restore money drill' },
      });
      expect(imported.status, `${tbl}: ${await imported.clone().text()}`).toBe(
        200,
      );
    }
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/restore-epoch`, {
          method: 'POST',
          json: {
            restore_point_at: Date.now() - 1000,
            reason: 'restore money drill',
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(`/admin/tenants/${a.tenantId}/maintenance`, {
          method: 'POST',
          json: { on: false },
        })
      ).status,
    ).toBe(200);
    expect(await snapshot()).toEqual(before);
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

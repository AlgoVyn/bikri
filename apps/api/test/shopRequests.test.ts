import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { testOutbox } from '../src/auth/mailer.ts';
import {
  addRequestEmail,
  checkRequestEmail,
  createShopRequest,
} from '../src/platform/shopRequests.ts';
import { api, json } from './helpers/fixtures.ts';

type Err = { error: { code: string } };

let ip = 0;
const nextIp = () => `10.80.0.${++ip}`;

function requestFields(email: string, extra: Record<string, unknown> = {}) {
  return {
    shop_name: `Shop ${email.split('@')[0]}`,
    owner_name: 'Owner',
    email,
    phone: '+923001234567',
    city: 'Lahore',
    business_type: 'mobile',
    note: 'Please approve',
    ...extra,
  };
}

async function publicRequest(
  email: string,
  extra: Record<string, unknown> = {},
) {
  const res = await api('/public/shop-requests', {
    method: 'POST',
    headers: { 'cf-connecting-ip': nextIp() },
    json: requestFields(email, extra),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return json<{ ok?: boolean; request_id?: string; status_token?: string }>(
    res,
  );
}

async function seedRequest(email: string) {
  return createShopRequest(env, requestFields(email));
}

const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  api(`/admin/shop-requests${path}`, init);

const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

describe('public shop requests (D-175)', () => {
  it('creates one pending request without leaking ids or tokens, and masks the email', async () => {
    const email = `new-${Date.now()}@example.com`;
    const created = await publicRequest(email);
    expect(created).toEqual({ ok: true });
    expect(created).not.toHaveProperty('request_id');
    expect(created).not.toHaveProperty('status_token');
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM shop_requests WHERE email = ?1',
        email,
      ),
    ).toBe(1);
    const seeded = await seedRequest(`token-${Date.now()}@example.com`);
    expect((seeded.token ?? '').length).toBeGreaterThan(20);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM shop_requests WHERE status_token_hash = ?1',
        seeded.token,
      ),
    ).toBe(0);
    const status = await api('/public/shop-requests/status', {
      method: 'POST',
      headers: { 'cf-connecting-ip': nextIp() },
      json: { token: seeded.token },
    });
    expect(status.status).toBe(200);
    const body = await json<{ status: string; email: string }>(status);
    expect(body.status).toBe('pending');
    expect(body.email).toContain('***');
  });

  it('does not create a second active row for the same email, and the honeypot stores nothing', async () => {
    const email = `dup-${Date.now()}@example.com`;
    const first = await publicRequest(email);
    const second = await publicRequest(email);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM shop_requests WHERE email = ?1 AND status IN ('pending','awaiting_email','email_verified','approving')",
        email,
      ),
    ).toBe(1);
    const before = await count('SELECT COUNT(*) AS n FROM shop_requests');
    const honeypot = await api('/public/shop-requests', {
      method: 'POST',
      headers: { 'cf-connecting-ip': nextIp() },
      json: {
        shop_name: 'Spam',
        owner_name: 'Spam',
        email: `spam-${Date.now()}@example.com`,
        website: 'https://spam.example',
      },
    });
    expect(honeypot.status).toBe(202);
    expect(await count('SELECT COUNT(*) AS n FROM shop_requests')).toBe(before);
  });

  it('rejects an oversized public body before parsing it', async () => {
    const res = await api('/public/shop-requests', {
      method: 'POST',
      headers: { 'cf-connecting-ip': nextIp() },
      body: 'x'.repeat(20 * 1024),
      json: undefined,
    });
    expect(res.status).toBe(413);
  });

  it('rejects a bad email and rate-limits repeated requests', async () => {
    const bad = await api('/public/shop-requests', {
      method: 'POST',
      headers: { 'cf-connecting-ip': nextIp() },
      json: {
        shop_name: 'Bad',
        owner_name: 'Owner',
        email: 'not-an-email',
      },
    });
    expect(bad.status).toBe(400);
  });
});

describe('operator request review (D-175)', () => {
  it('requires a verified email, then approves exactly once and creates the owner code', async () => {
    const email = `approve-${Date.now()}@example.com`;
    const created = await seedRequest(email);

    const list = await admin(`?q=${encodeURIComponent(email)}`);
    expect(list.status).toBe(200);
    const listed = await json<{ requests: { id: string }[] }>(list);
    expect(listed.requests.some((row) => row.id === created.id)).toBe(true);

    const blocked = await admin(`/${created.id}/approve`, {
      method: 'POST',
      json: {},
    });
    expect(blocked.status).toBe(409);
    expect((await json<Err>(blocked)).error.code).toBe('EMAIL_NOT_VERIFIED');

    const manual = await admin(`/${created.id}/email/manual`, {
      method: 'POST',
      json: { note: 'Checked in Cloudflare dashboard' },
    });
    expect(manual.status, await manual.clone().text()).toBe(200);
    const afterManual = await json<{ request: { status: string } }>(manual);
    expect(afterManual.request.status).toBe('email_verified');

    const approved = await admin(`/${created.id}/approve`, {
      method: 'POST',
      json: {},
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const result = await json<{
      tenant: { id: string; slug: string; owner_email: string };
      owner_code: { code: string; link: string; expires_at: number };
      invite_email_sent: boolean;
      already_approved: boolean;
    }>(approved);
    expect(result.tenant.slug).toMatch(/^[a-z0-9-]{3,30}$/u);
    expect(result.owner_code.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    expect(result.owner_code.link).toContain('/bikri/enrol?code=');
    expect(result.invite_email_sent).toBe(true);
    expect(testOutbox.at(-1)?.to).toBe(email);
    expect(testOutbox.at(-1)?.text).toContain(result.owner_code.code);

    const request = await env.DB.prepare(
      'SELECT status, tenant_id, reviewed_by FROM shop_requests WHERE id = ?1',
    )
      .bind(created.id)
      .first<{ status: string; tenant_id: string; reviewed_by: string }>();
    expect(request).toMatchObject({
      status: 'approved',
      tenant_id: result.tenant.id,
      reviewed_by: 'operator@example.com',
    });
    const tenant = await env.DB.prepare(
      'SELECT owner_email, slug FROM tenants WHERE id = ?1',
    )
      .bind(result.tenant.id)
      .first<{ owner_email: string; slug: string }>();
    expect(tenant).toEqual({
      owner_email: email,
      slug: result.tenant.slug,
    });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM operator_audit WHERE request_id = ?1 AND action = 'shop_request_approve'",
        created.id,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?1 AND action = 'shop_request_approved'",
        result.tenant.id,
      ),
    ).toBe(1);

    const again = await admin(`/${created.id}/approve`, {
      method: 'POST',
      json: {},
    });
    expect(again.status).toBe(200);
    const againBody = await json<{
      already_approved: boolean;
      owner_code: unknown;
    }>(again);
    expect(againBody.already_approved).toBe(true);
    expect(againBody.owner_code).toBeNull();
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM tenants WHERE owner_email = ?1',
        email,
      ),
    ).toBe(1);

    const status = await api('/public/shop-requests/status', {
      method: 'POST',
      headers: { 'cf-connecting-ip': nextIp() },
      json: { token: created.token },
    });
    expect((await json<{ status: string }>(status)).status).toBe('approved');
  });

  it('rejects without a tenant, reopens, and can be verified/approved later', async () => {
    const email = `reject-${Date.now()}@example.com`;
    const created = await seedRequest(email);
    const rejected = await admin(`/${created.id}/reject`, {
      method: 'POST',
      json: { reason: 'Not a real shop' },
    });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM tenants WHERE owner_email = ?1',
        email,
      ),
    ).toBe(0);
    const row = await env.DB.prepare(
      'SELECT status, reject_reason FROM shop_requests WHERE id = ?1',
    )
      .bind(created.id)
      .first<{ status: string; reject_reason: string }>();
    expect(row).toEqual({
      status: 'rejected',
      reject_reason: 'Not a real shop',
    });
    const reopened = await admin(`/${created.id}/reopen`, {
      method: 'POST',
      json: { reason: 'Rechecked' },
    });
    expect(reopened.status, await reopened.clone().text()).toBe(200);
    const reopenedRow = await json<{ status: string }>(reopened);
    expect(reopenedRow.status).toBe('pending');
    const manual = await admin(`/${created.id}/email/manual`, {
      method: 'POST',
      json: { note: 'Checked in Cloudflare dashboard' },
    });
    expect(manual.status, await manual.clone().text()).toBe(200);
    const approved = await admin(`/${created.id}/approve`, {
      method: 'POST',
      json: {},
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
  });

  it('adds and checks the email through the Cloudflare API when configured', async () => {
    const email = `cf-${Date.now()}@example.com`;
    const created = await seedRequest(email);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url.pathname}`);
        if (url.pathname.endsWith('/addresses') && method === 'GET')
          return new Response(JSON.stringify({ success: true, result: [] }), {
            status: 200,
          });
        if (url.pathname.endsWith('/addresses') && method === 'POST')
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: 'addr-1', email, verified: false },
            }),
            { status: 200 },
          );
        if (url.pathname.endsWith('/addresses/addr-1'))
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: 'addr-1', email, verified: true },
            }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 1000 }] }),
          { status: 400 },
        );
      }),
    );
    const proxied = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === 'EMAIL_ROUTING_TOKEN') return 'test-email-token';
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      const added = await addRequestEmail(
        proxied,
        created.id,
        'operator@example.com',
      );
      expect(added.verified).toBe(false);
      expect(calls).toContain(
        'POST /client/v4/accounts/e71e6ef868a1404888d1751c815913b5/email/routing/addresses',
      );
      const checked = await checkRequestEmail(
        proxied,
        created.id,
        'operator@example.com',
      );
      expect(checked.verified).toBe(true);
      expect(checked.status).toBe('email_verified');
      const approved = await admin(`/${created.id}/approve`, {
        method: 'POST',
        json: {},
      });
      expect(approved.status, await approved.clone().text()).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

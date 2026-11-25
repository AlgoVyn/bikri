import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { verifyAccessJwt } from '../src/auth/access.ts';
import { base64url } from '../src/auth/crypto.ts';
import {
  codeOfInvoice,
  indexOfCode,
  nextDeviceCode,
} from '../src/auth/deviceCodes.ts';
import {
  sendShopInviteEmail,
  sendSigninEmail,
  testMail,
  testOutbox,
} from '../src/auth/mailer.ts';
import { scheduled } from '../src/cron/prune.ts';
import { ApiError } from '../src/errors.ts';
import { statusForError } from '../src/middleware/onError.ts';
import { assertSafeEnv } from '../src/middleware/sameOrigin.ts';
import { releaseFileBytes } from '../src/platform/fileUsage.ts';
import { health } from '../src/routes/health.ts';
import { isSyncedTable } from '../src/sync/tables.ts';
import { api, seedShop } from './helpers/fixtures.ts';

// Small pure branches that the endpoint suites do not need to exercise, kept in one
// place so the Worker coverage gate measures real behaviour rather than incidental paths.
describe('Worker coverage gaps', () => {
  it('maps errors to the status the request log reports', () => {
    expect(statusForError(new ApiError('FORBIDDEN', 403, 'no'))).toBe(403);
    expect(statusForError(new ZodError([]))).toBe(400);
    expect(statusForError(new SyntaxError('bad json'))).toBe(400);
    expect(
      statusForError(
        new Error("D1_ERROR: exceeded D1's free tier daily row write limit"),
      ),
    ).toBe(503);
    expect(statusForError(new Error('boom'))).toBe(500);
  });

  it('rejects malformed or unverifiable Access JWTs', async () => {
    const options = {
      teamDomain: 'team.example.com',
      aud: 'aud',
      fetcher: async () => ({ keys: [] }),
    };
    for (const token of ['', 'a.b', '!!!.???.###', 'a.b.c.d'])
      expect(await verifyAccessJwt(token, options)).toBeNull();
    const segment = (value: unknown) =>
      base64url(new TextEncoder().encode(JSON.stringify(value)));
    const now = Math.floor(Date.now() / 1000);
    const token = `${segment({ alg: 'RS256', kid: 'missing' })}.${segment({
      aud: 'aud',
      iss: 'https://team.example.com',
      exp: now + 60,
      email: 'owner@example.com',
    })}.AA`;
    expect(await verifyAccessJwt(token, options)).toBeNull();
    const hs = `${segment({ alg: 'HS256', kid: 'x' })}.${segment({ aud: 'aud' })}.AA`;
    expect(await verifyAccessJwt(hs, options)).toBeNull();
  });

  it('caps the test outbox and reports a failed provider send', async () => {
    for (let index = 0; index < 205; index += 1) {
      await sendSigninEmail(env, 'owner@example.test', {
        code: '123456',
        shopName: 'Shop',
        deviceName: 'Counter',
      });
      await sendShopInviteEmail(env, 'owner@example.test', {
        shopName: 'Shop',
        code: 'ABC-DEF',
        link: 'https://algovyn.com/bikri/enrol?code=ABC-DEF',
        expiresAt: Date.now() + 3_600_000,
      });
    }
    expect(testOutbox.length).toBeLessThanOrEqual(200);
    testMail.fail = true;
    try {
      expect(
        await sendShopInviteEmail(env, 'owner@example.test', {
          shopName: 'Shop',
          code: 'ABC-DEF',
          link: 'https://algovyn.com/bikri/enrol?code=ABC-DEF',
          expiresAt: Date.now() + 3_600_000,
        }),
      ).toBe(false);
    } finally {
      testMail.fail = false;
    }
  });

  it('reports an unreachable primary database as unhealthy', async () => {
    const context = {
      env: {
        DB: {
          prepare: () => ({
            first: async () => {
              throw new Error('database unavailable');
            },
          }),
        },
        APP_VERSION: '1.1.0',
        SCHEMA_VERSION: '9',
        MIN_CLIENT_SCHEMA: '1',
      },
      json: (body: unknown, status: number) =>
        Response.json(body as Record<string, unknown>, { status }),
    };
    const res = await health(
      context as unknown as Parameters<typeof health>[0],
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: false });
  });

  it('knows synced and platform tables', () => {
    expect(isSyncedTable('products')).toBe(true);
    expect(isSyncedTable('sales')).toBe(true);
    expect(isSyncedTable('tenants')).toBe(false);
    expect(isSyncedTable('not_a_table')).toBe(false);
  });

  it('parses and advances device codes', () => {
    expect(indexOfCode('bad!')).toBe(-1);
    expect(indexOfCode('A')).toBe(0);
    expect(indexOfCode('B')).toBe(1);
    expect(nextDeviceCode([])).toBe('A');
    expect(nextDeviceCode(['A', 'C'])).toBe('D');
    expect(codeOfInvoice('INV-A-1042')).toBe('A');
    expect(codeOfInvoice('not-an-invoice')).toBeNull();
  });

  it('returns 404 for an unknown shop-request status token', async () => {
    const res = await api('/public/shop-requests/status', {
      method: 'POST',
      json: { token: 'A'.repeat(43) },
    });
    expect(res.status).toBe(404);
  });

  it('refuses every device request during deployment maintenance', async () => {
    const shop = await seedShop('Maintenance gate');
    const previous = env.MAINTENANCE;
    try {
      (env as { MAINTENANCE: string }).MAINTENANCE = '1';
      const res = await api('/me', { token: shop.till.token });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('300');
    } finally {
      (env as { MAINTENANCE: string }).MAINTENANCE = previous;
    }
  });

  it('rejects a test deployment on a non-test origin', () => {
    expect(() =>
      assertSafeEnv({
        ENV: 'test',
        ALLOWED_ORIGINS: 'https://algovyn.com',
      } as unknown as Env),
    ).toThrow(/ENV=test/u);
    expect(() =>
      assertSafeEnv({
        ENV: 'test',
        ALLOWED_ORIGINS: 'https://bikri.test',
      } as unknown as Env),
    ).not.toThrow();
  });

  it('rejects malformed JSON bodies before routing', async () => {
    const res = await api('/devices/enrol', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken":',
    });
    expect(res.status).toBe(400);
  });

  it('serves the test outbox only to a local test host', async () => {
    const remote = await api('/__test/outbox');
    expect(remote.status).toBe(404);
    const local = await SELF.fetch(
      'https://bikri.test/bikri/api/__test/outbox',
      {
        headers: { origin: 'https://bikri.test' },
      },
    );
    expect(local.status).toBe(200);
  });

  it('runs the scheduled prune entry point', async () => {
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);
  });

  it('clamps released file bytes at zero', async () => {
    const shop = await seedShop('File usage');
    await env.DB.prepare('UPDATE tenants SET file_bytes = 100 WHERE id = ?1')
      .bind(shop.tenantId)
      .run();
    await releaseFileBytes(env, shop.tenantId, 30);
    const after = await env.DB.prepare(
      'SELECT file_bytes FROM tenants WHERE id = ?1',
    )
      .bind(shop.tenantId)
      .first<{ file_bytes: number }>();
    expect(after?.file_bytes).toBe(70);
    await releaseFileBytes(env, shop.tenantId, 500);
    const clamped = await env.DB.prepare(
      'SELECT file_bytes FROM tenants WHERE id = ?1',
    )
      .bind(shop.tenantId)
      .first<{ file_bytes: number }>();
    expect(clamped?.file_bytes).toBe(0);
  });
});

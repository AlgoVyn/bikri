import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { SECURITY_HEADERS } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../src/errors.ts';
import { app } from '../src/index.ts';
import { TEST_ORIGIN } from './helpers/fixtures.ts';

const API = 'https://algovyn.com/bikri/api';

app.get('/__test/api-error', () => {
  throw new ApiError('FORBIDDEN', 403, 'Not allowed', { reason: 'test' });
});

app.post('/__test/zod', async (c) => {
  z.object({ name: z.string() }).parse(await c.req.json());
  return c.json({ ok: true });
});

app.get('/__test/boom', () => {
  throw new Error('database exploded');
});

app.get('/__test/d1-limit', () => {
  throw new Error(
    "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
  );
});

function expectSecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(headers.get(name)).toBe(value);
  }
  expect(headers.get('access-control-allow-origin')).toBeNull();
}

describe('worker', () => {
  it('GET /bikri/api/health returns versions and security headers', async () => {
    const response = await SELF.fetch(`${API}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expectSecurityHeaders(response.headers);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      ok: true,
      app_version: '0.1.0',
      schema_version: 1,
      min_client_schema: 1,
      db: 'ok',
    });
    if (typeof body !== 'object' || body === null || !('time' in body)) {
      throw new Error('health response is missing time');
    }
    expect(typeof body.time).toBe('number');
  });

  it('unknown /bikri/api/* is a JSON 404', async () => {
    const response = await SELF.fetch(`${API}/nope`);
    expect(response.status).toBe(404);
    expectSecurityHeaders(response.headers);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  it('maps ApiError, ZodError, and unexpected errors', async () => {
    const forbidden = await app.request(`${API}/__test/api-error`);
    expect(forbidden.status).toBe(403);
    expectSecurityHeaders(forbidden.headers);
    await expect(forbidden.json()).resolves.toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Not allowed',
        details: { reason: 'test' },
      },
    });

    const invalid = await app.request(
      `${API}/__test/zod`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
        body: JSON.stringify({ name: 1 }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
    expectSecurityHeaders(invalid.headers);
    const invalidBody: unknown = await invalid.json();
    expect(invalidBody).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { path: ['name'] } },
    });

    const internal = await app.request(`${API}/__test/boom`);
    expect(internal.status).toBe(500);
    expectSecurityHeaders(internal.headers);
    const internalBody: unknown = await internal.json();
    expect(internalBody).toMatchObject({
      error: { code: 'INTERNAL', message: 'Internal error' },
    });
    if (
      typeof internalBody !== 'object' ||
      internalBody === null ||
      !('error' in internalBody) ||
      typeof internalBody.error !== 'object' ||
      internalBody.error === null ||
      !('details' in internalBody.error) ||
      typeof internalBody.error.details !== 'object' ||
      internalBody.error.details === null ||
      !('request_id' in internalBody.error.details)
    ) {
      throw new Error('internal error is missing request_id');
    }
    expect(typeof internalBody.error.details.request_id).toBe('string');
    expect(JSON.stringify(internalBody)).not.toContain('database exploded');

    // D1's account-wide daily limit → 503 D1_LIMIT with Retry-After (04 §3).
    const limit = await app.request(`${API}/__test/d1-limit`);
    expect(limit.status).toBe(503);
    const wait = Number(limit.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400);
    await expect(limit.json()).resolves.toMatchObject({
      error: { code: 'D1_LIMIT' },
    });
  });
});

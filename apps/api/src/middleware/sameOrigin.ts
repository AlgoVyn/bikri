import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../errors.ts';

export function allowedOrigins(env: Env): string[] {
  return String(env.ALLOWED_ORIGINS)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CSRF guard (01 §5): every /admin request with a cross-site `Sec-Fetch-Site` is refused, and every
 * non-GET API request must carry an allowed `Origin`.
 */
export const sameOrigin: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const path = new URL(c.req.url).pathname;
  const site = c.req.header('sec-fetch-site');
  if (
    path.includes('/api/admin') &&
    site !== undefined &&
    site !== 'same-origin'
  ) {
    throw new ApiError('FORBIDDEN', 403, 'Cross-site request');
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (!origin || !allowedOrigins(c.env).includes(origin)) {
      throw new ApiError('FORBIDDEN', 403, 'Origin not allowed');
    }
  }
  await next();
};

/** The ACCESS_TEST_EMAIL bypass must never reach production (10 §5). */
export function assertSafeEnv(env: Env): void {
  const test = String(env.ENV) === 'test';
  if (test) {
    const origins = allowedOrigins(env);
    const safe = origins.every(
      (origin) =>
        /^http:\/\/localhost(?::\d+)?$/u.test(origin) ||
        origin === 'https://bikri.test',
    );
    if (!safe || origins.length === 0)
      throw new Error('ENV=test must only run on a local/test origin');
  }
}

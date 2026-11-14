import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../types.ts';

/** One structured line per API request; never includes search text, email addresses or rows. */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID();
  const start = performance.now();
  c.header('X-Request-Id', id);
  try {
    await next();
  } finally {
    const route = new URL(c.req.url).pathname
      // The plain enrolment code is a credential; never put it in Workers Logs.
      .replace(
        /\/shop\/enrolment-codes\/[^/]+/u,
        '/shop/enrolment-codes/:code',
      );
    const vars = c.var as {
      tenant?: { id?: string };
      device?: { id?: string };
    };
    // `finally` runs before Hono's onError turns a thrown error into a response, so
    // `c.res.status` is still 200. Report the thrown ApiError's own status (a validation
    // 400 or a missing-resource 404 is not a server fault); anything else is a 500.
    const error = (c as { error?: unknown }).error;
    const status =
      error instanceof ApiError
        ? error.status
        : error !== undefined
          ? 500
          : c.res.status;
    console.log(
      JSON.stringify({
        level: 'info',
        request_id: id,
        method: c.req.method,
        route,
        status,
        tenant_id: vars.tenant?.id ?? null,
        device_id: vars.device?.id ?? null,
        ms: Math.round(performance.now() - start),
      }),
    );
  }
};

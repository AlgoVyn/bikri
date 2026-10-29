import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

/** One structured line per API request; never includes search text, email addresses or rows. */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID();
  const start = performance.now();
  c.header('X-Request-Id', id);
  try {
    await next();
  } finally {
    const route = new URL(c.req.url).pathname;
    const vars = c.var as {
      tenant?: { id?: string };
      device?: { id?: string };
    };
    console.log(
      JSON.stringify({
        level: 'info',
        request_id: id,
        method: c.req.method,
        route,
        status: c.res.status,
        tenant_id: vars.tenant?.id ?? null,
        device_id: vars.device?.id ?? null,
        ms: Math.round(performance.now() - start),
      }),
    );
  }
};

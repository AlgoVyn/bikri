import type { MiddlewareHandler } from 'hono';
import type { ErrorStatus } from '../errors.ts';
import type { AppEnv } from '../types.ts';
import { statusForError } from './onError.ts';

/** One structured line per API request; never includes search text, email addresses or rows. */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID();
  const start = performance.now();
  c.header('X-Request-Id', id);
  const write = (status: ErrorStatus | number) => {
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
  };
  try {
    await next();
  } catch (error) {
    // Hono's onError turns the throw into a response only after this middleware
    // unwinds, so report the mapped status here and let the error keep propagating.
    write(statusForError(error));
    throw error;
  }
  write(c.res.status);
};

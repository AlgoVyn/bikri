import type { Context } from 'hono';
import { primaryDbReachable } from '../platform/health.ts';

export async function health(c: Context<{ Bindings: Env }>): Promise<Response> {
  const db: 'ok' | false = (await primaryDbReachable(c.env)) ? 'ok' : false;

  return c.json(
    {
      ok: db === 'ok',
      app_version: c.env.APP_VERSION,
      schema_version: Number(c.env.SCHEMA_VERSION),
      min_client_schema: Number(c.env.MIN_CLIENT_SCHEMA),
      db,
      time: Date.now(),
    },
    db === 'ok' ? 200 : 503,
  );
}

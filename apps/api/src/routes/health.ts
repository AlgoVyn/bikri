import type { Context } from 'hono';

export async function health(c: Context<{ Bindings: Env }>): Promise<Response> {
  let db: 'ok' | false = false;
  try {
    await c.env.DB.prepare('SELECT 1').first();
    db = 'ok';
  } catch {
    db = false;
  }

  return c.json({
    ok: true,
    app_version: c.env.APP_VERSION,
    schema_version: Number(c.env.SCHEMA_VERSION),
    min_client_schema: Number(c.env.MIN_CLIENT_SCHEMA),
    db,
    time: Date.now(),
  });
}

import { API_BASE } from '@bikri/core';
import { Hono } from 'hono';
import { scheduled } from './cron/prune.ts';
import { onError } from './middleware/onError.ts';
import {
  applySecurityHeaders,
  securityHeaders,
} from './middleware/securityHeaders.ts';
import { health } from './routes/health.ts';

const app = new Hono<{ Bindings: Env }>().basePath(API_BASE);

app.use('*', securityHeaders);
app.get('/health', health);

app.notFound((c) => {
  applySecurityHeaders(c);
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
});

app.onError(onError);

export { app };

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled,
};

export default handler;

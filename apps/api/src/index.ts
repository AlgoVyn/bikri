import { API_BASE } from '@bikri/core';
import { Hono } from 'hono';
import { scheduled } from './cron/prune.ts';
import { accessAuth } from './middleware/accessAuth.ts';
import { deviceAuth, tenantGate } from './middleware/deviceAuth.ts';
import { onError } from './middleware/onError.ts';
import { assertSafeEnv, sameOrigin } from './middleware/sameOrigin.ts';
import {
  applySecurityHeaders,
  securityHeaders,
} from './middleware/securityHeaders.ts';
import { admin } from './routes/admin.ts';
import { enrol } from './routes/enrol.ts';
import { getFile, putFile } from './routes/files.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
import { pull, push, snapshot } from './routes/sync.ts';
import type { AppEnv } from './types.ts';

const app = new Hono<AppEnv>().basePath(API_BASE);

app.use('*', securityHeaders, sameOrigin);
app.get('/health', health);
app.post('/devices/enrol', enrol);

// Device-authenticated routes: the tenant comes only from the token (13 §5).
for (const path of ['/me', '/sync/*', '/files/*', '/shop/*']) {
  app.use(path, deviceAuth, tenantGate);
}
app.get('/me', me);
app.post('/sync/push', push);
app.get('/sync/pull', pull);
app.get('/sync/snapshot', snapshot);
app.put('/files/:kind/:id/:sha256', putFile);
app.get('/files/*', getFile);

// Operator console API: Cloudflare Access only, never a device token (screens/19 AC 7).
app.use('/admin/*', accessAuth);
app.route('/admin', admin as unknown as Hono<AppEnv>);

app.notFound((c) => {
  applySecurityHeaders(c);
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
});

app.onError(onError);

export { app };

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => {
    assertSafeEnv(env);
    return app.fetch(request, env, ctx);
  },
  scheduled,
};

export default handler;

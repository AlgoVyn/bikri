import type { Context } from 'hono';
import { hex } from '../auth/crypto.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../types.ts';
import { assertCanWrite } from './sync.ts';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Per-shop cap; the shared 10 GB bucket must not be fillable by one tenant. */
const MAX_TENANT_FILE_BYTES = 1_000_000_000;
const TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const SHA = /^[0-9a-f]{64}$/u;
/** The only relative keys a till may read (04 §3.6). */
const READABLE = [
  /^products\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9a-f]{64}\.webp$/u,
  /^shop\/logo-[0-9a-f]{64}\.png$/u,
];

/** R2 key of a tenant's file: always built here from the token's tenant (13 §5). */
export function tenantKey(tenantId: string, relative: string): string {
  return `t/${tenantId}/${relative}`;
}

const notFound = () => new ApiError('NOT_FOUND', 404, 'Not found');

/** `PUT /api/files/:kind/:id/:sha256` (04 §3.5). */
export async function putFile(c: Context<AppEnv>): Promise<Response> {
  const { tenant, device } = c.var;
  assertCanWrite(device);
  if (tenant.status === 'read_only') {
    throw new ApiError('TENANT_READ_ONLY', 403, 'This shop is read-only', {
      since: tenant.status_changed_at,
    });
  }
  const { kind, id, sha256 } = c.req.param() as {
    kind: string;
    id: string;
    sha256: string;
  };
  let relative: string;
  if (kind === 'product_image' && ULID.test(id))
    relative = `products/${id}/${sha256}.webp`;
  else if (kind === 'logo' && id === 'shop')
    relative = `shop/logo-${sha256}.png`;
  else throw new ApiError('VALIDATION_FAILED', 400, 'Unknown file kind or id');
  if (!SHA.test(sha256))
    throw new ApiError(
      'VALIDATION_FAILED',
      400,
      'sha256 must be 64 hex characters',
    );
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!TYPES.has(type))
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'Upload webp, png or jpeg',
    );
  if (Number(c.req.header('content-length') ?? '0') > MAX_IMAGE_BYTES)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Image is over 2 MB');
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_IMAGE_BYTES)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Image is over 2 MB');
  if (hex(await crypto.subtle.digest('SHA-256', body)) !== sha256)
    throw new ApiError(
      'VALIDATION_FAILED',
      400,
      'sha256 does not match the body',
    );
  if (kind === 'product_image') {
    const product = await c.var.db.first<{ id: string }>(
      'SELECT id FROM products WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL',
      id,
    );
    if (!product) throw notFound();
  }
  const key = tenantKey(tenant.id, relative);
  if (await c.env.FILES.head(key))
    return c.json({ key: relative, size: body.byteLength }, 200);
  let used = 0;
  let cursor: string | undefined;
  do {
    const page = await c.env.FILES.list({
      prefix: `t/${tenant.id}/`,
      ...(cursor ? { cursor } : {}),
      limit: 1000,
    });
    for (const object of page.objects) used += object.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (used + body.byteLength > MAX_TENANT_FILE_BYTES)
    throw new ApiError(
      'TENANT_QUOTA',
      429,
      'This shop has reached its file storage limit',
    );
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: type } });
  return c.json({ key: relative, size: body.byteLength }, 201);
}

/** `GET /api/files/*key` (04 §3.6): only the caller's tenant prefix, only known key shapes. */
export async function getFile(c: Context<AppEnv>): Promise<Response> {
  const { tenant } = c.var;
  const prefix = `${c.env.BASE_PATH}/api/files/`;
  const path = new URL(c.req.url).pathname;
  const relative = decodeURIComponent(
    path.startsWith(prefix) ? path.slice(prefix.length) : '',
  );
  if (!READABLE.some((r) => r.test(relative))) throw notFound();
  const object = await c.env.FILES.get(tenantKey(tenant.id, relative));
  if (!object) throw notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

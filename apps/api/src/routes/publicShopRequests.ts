/** Public shop-registration request endpoints (no device token, no tenant; D-175). */
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { readJsonBody } from '../middleware/body.ts';
import { createShopRequest, statusByToken } from '../platform/shopRequests.ts';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

const RequestBody = z.object({
  shop_name: z.string().trim().min(1).max(60),
  owner_name: z.string().trim().min(1).max(60),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .regex(EMAIL_RE, 'Enter a valid email address'),
  phone: z.string().trim().max(30).default(''),
  city: z.string().trim().max(60).default(''),
  business_type: z.string().trim().max(40).default('other'),
  note: z.string().trim().max(500).default(''),
  /** Honeypot: real people never fill this. */
  website: z.string().max(200).optional(),
});

const StatusBody = z.object({
  token: z.string().trim().min(20).max(120),
});

export const publicShopRequests = new Hono<{ Bindings: Env }>();

async function limit(
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  key: string,
): Promise<void> {
  const limiter = c.env.REGISTER_LIMIT;
  if (!limiter) return;
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const { success } = await limiter.limit({ key: `${key}:${ip}` });
  if (!success)
    throw new ApiError(
      'RATE_LIMITED',
      429,
      'Too many requests. Try again later.',
      { retry_after: 60 },
      { 'Retry-After': '60' },
    );
}

publicShopRequests.post('/shop-requests', async (c) => {
  await limit(c, 'shop-request');
  const body = RequestBody.parse(await readJsonBody(c, 16 * 1024));
  // A filled honeypot gets the same answer as a real request; nothing is stored.
  if (body.website) return c.json({ ok: true }, 202);
  await createShopRequest(c.env, body);
  // Same body for a new request, a duplicate email, and the honeypot so the
  // response cannot be used to probe whether an address is already registered.
  return c.json({ ok: true }, 202);
});

publicShopRequests.post('/shop-requests/status', async (c) => {
  await limit(c, 'shop-request-status');
  const body = StatusBody.parse(await readJsonBody(c, 8 * 1024));
  const status = await statusByToken(c.env, body.token);
  if (!status) throw new ApiError('NOT_FOUND', 404, 'Request not found');
  return c.json(status);
});

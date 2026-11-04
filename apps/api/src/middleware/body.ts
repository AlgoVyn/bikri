import type { Context } from 'hono';
import { ApiError } from '../errors.ts';

/**
 * Read and parse a JSON body with a hard byte cap. `c.req.json()` parses the whole body
 * before Zod sees it, so unauthenticated or owner-only import routes need this guard.
 */
export async function readJsonBody<E extends { Bindings: Env }>(
  c: Context<E>,
  maxBytes: number,
): Promise<unknown> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large');
  const text = await c.req.text();
  if (text.length > maxBytes)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('VALIDATION_FAILED', 400, 'Body is not JSON');
  }
}

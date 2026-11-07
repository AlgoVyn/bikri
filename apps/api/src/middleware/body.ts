import type { Context } from 'hono';
import { ApiError } from '../errors.ts';

/**
 * Read a request body as bytes with a hard cap, without buffering an over-limit chunked
 * body first. `content-length` is checked before reading; the stream counter catches a
 * missing or lying header.
 */
export async function readBodyBytes<E extends { Bindings: Env }>(
  c: Context<E>,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes)
    throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large');
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Read a UTF-8 text body with the same hard cap. */
export async function readTextBody<E extends { Bindings: Env }>(
  c: Context<E>,
  maxBytes: number,
): Promise<string> {
  const bytes = await readBodyBytes(c, maxBytes);
  return new TextDecoder().decode(bytes);
}

/**
 * Read and parse a JSON body with a hard byte cap. `c.req.json()` parses the whole body
 * before Zod sees it, so unauthenticated or owner-only import routes need this guard.
 */
export async function readJsonBody<E extends { Bindings: Env }>(
  c: Context<E>,
  maxBytes: number,
): Promise<unknown> {
  const text = await readTextBody(c, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('VALIDATION_FAILED', 400, 'Body is not JSON');
  }
}

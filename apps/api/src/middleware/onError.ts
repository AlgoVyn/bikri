import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ApiError } from '../errors.ts';
import { secondsToUtcMidnight } from '../platform/tenants.ts';
import { applySecurityHeaders } from './securityHeaders.ts';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function jsonError(
  c: Context,
  status: ApiError['status'],
  body: ErrorBody,
): Response {
  applySecurityHeaders(c);
  return c.json(body, status);
}

function zodPath(path: ReadonlyArray<PropertyKey>): Array<string | number> {
  return path.map((segment) =>
    typeof segment === 'string' || typeof segment === 'number'
      ? segment
      : String(segment),
  );
}

/** D1's own refusal once the account's free daily rows are used (Cloudflare D1 debug docs). */
export const D1_LIMIT_RE =
  /exceeded D1's free tier daily row (?:read|write) limit/iu;

export function onError<E extends { Bindings: Env }>(
  err: Error,
  c: Context<E>,
): Response {
  if (err instanceof ApiError) {
    for (const [name, value] of Object.entries(err.headers)) {
      c.header(name, value);
    }
    return jsonError(c, err.status, {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
  }

  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return jsonError(c, 400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: issue?.message ?? 'Validation failed',
        details: { path: zodPath(issue?.path ?? []) },
      },
    });
  }

  // Account-wide D1 free-tier limit (04 §3, 13 §6): every shop waits for 00:00 UTC.
  if (D1_LIMIT_RE.test(err.message)) {
    const wait = secondsToUtcMidnight(Date.now());
    c.header('Retry-After', String(wait));
    return jsonError(c, 503, {
      error: {
        code: 'D1_LIMIT',
        message:
          'The daily database limit is reached; sync resumes after 00:00 UTC',
        details: { retry_after: wait },
      },
    });
  }

  const requestId = crypto.randomUUID();
  console.error(
    JSON.stringify({ request_id: requestId, message: err.message }),
  );
  return jsonError(c, 500, {
    error: {
      code: 'INTERNAL',
      message: 'Internal error',
      details: { request_id: requestId },
    },
  });
}

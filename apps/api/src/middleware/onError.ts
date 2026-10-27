import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ApiError } from '../errors.ts';
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

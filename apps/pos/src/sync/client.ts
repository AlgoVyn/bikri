/** Till HTTP client (03 §4, 04 §2): bearer token from kv, pending report header, typed errors. */
import { API_BASE } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { getKv } from '../data/kv.ts';

export class SyncHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryAfter: number | null;
  constructor(
    code: string,
    status: number,
    message: string,
    details: Record<string, unknown>,
    retryAfter: number | null,
  ) {
    super(message);
    this.name = 'SyncHttpError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

export class OfflineError extends Error {
  constructor(cause?: unknown) {
    super('network unavailable');
    this.name = 'OfflineError';
    this.cause = cause;
  }
}

export function deviceToken(db: BikriDb): Promise<string | null> {
  return getKv<string | null>(db, 'device_token', null);
}

/** `X-Bikri-Pending: <count>;<oldest created_at or 0>` (03 §6). */
export async function pendingHeader(db: BikriDb): Promise<string> {
  const pending = db.outbox.where('status').equals('pending');
  const count = await pending.count();
  const first =
    count > 0
      ? await db.outbox.where('status').equals('pending').first()
      : undefined;
  return `${count};${first?.created_at ?? 0}`;
}

export type RequestOptions = {
  method?: string;
  json?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: options.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    throw new OfflineError(error);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (
      data as {
        error?: {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
      } | null
    )?.error;
    const retry = Number(res.headers.get('retry-after'));
    throw new SyncHttpError(
      err?.code ?? (res.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR'),
      res.status,
      err?.message ?? res.statusText,
      err?.details ?? {},
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return data as T;
}

/** A request as this till: token and pending report from the tenant database. */
export async function tillRequest<T>(
  db: BikriDb,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const token = await deviceToken(db);
  if (!token)
    throw new SyncHttpError('UNAUTHENTICATED', 401, 'not enrolled', {}, null);
  return request<T>(path, {
    ...options,
    token,
    headers: {
      'x-bikri-pending': await pendingHeader(db),
      ...(options.headers ?? {}),
    },
  });
}

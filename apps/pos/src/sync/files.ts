/** File queue upload and download (T-033, 04 §3.5–3.6). R2 keys get the tenant prefix on the server. */
import { API_BASE } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { putFile } from '../data/fileCache.ts';
import {
  deviceToken,
  OfflineError,
  REQUEST_TIMEOUT_MS,
  SyncHttpError,
} from './client.ts';

/** Uploads pending photos/logos; a 4xx marks the entry failed, network errors leave it pending. */
export async function uploadQueued(db: BikriDb, max = 30): Promise<number> {
  const token = await deviceToken(db);
  if (!token) return 0;
  const pending = await db.file_queue
    .where('status')
    .equals('pending')
    .limit(max)
    .toArray();
  const uploadOne = async (e: (typeof pending)[number]): Promise<boolean> => {
    if (e.id === undefined) return false;
    const id = e.kind === 'logo' ? 'shop' : e.target_id;
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/files/${e.kind}/${encodeURIComponent(id)}/${e.sha256}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': e.blob.type || 'image/webp',
            ...(e.staff_id ? { 'x-bikri-staff': e.staff_id } : {}),
          },
          body: e.blob,
          credentials: 'omit',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new OfflineError(error);
    }
    if (res.ok) {
      await db.file_queue.delete(e.id);
      return true;
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code ?? 'HTTP_ERROR';
    if (
      (res.status >= 500 && code !== 'TENANT_STORAGE_FULL') ||
      res.status === 408 ||
      res.status === 425 ||
      res.status === 429 ||
      code === 'TENANT_READ_ONLY' ||
      code === 'TENANT_QUOTA' ||
      code === 'UNAUTHENTICATED' ||
      code === 'DEVICE_REVOKED' ||
      code === 'TENANT_SUSPENDED' ||
      code === 'SCHEMA_OUTDATED'
    ) {
      const retry = Number(res.headers.get('retry-after'));
      throw new SyncHttpError(
        code,
        res.status,
        body?.error?.message ?? '',
        {},
        Number.isFinite(retry) && retry > 0 ? retry : null,
      );
    }
    await db.file_queue.update(e.id, { status: 'failed' });
    return false;
  };
  // Three concurrent uploads: a 1,000-photo import used to take 100 sync cycles
  // (10 serial files each). The server reserves R2 usage atomically, so parallel
  // uploads cannot overrun the per-shop cap.
  let done = 0;
  for (let at = 0; at < pending.length; at += 3) {
    const batch = pending.slice(at, at + 3);
    const results = await Promise.all(batch.map((entry) => uploadOne(entry)));
    done += results.filter(Boolean).length;
  }
  return done;
}

/** Downloads a file of this shop into the local cache; null when not enrolled, offline or missing. */
export async function fetchRemoteFile(
  db: BikriDb,
  key: string,
): Promise<Blob | null> {
  const token = await deviceToken(db);
  if (!token) return null;
  try {
    const res = await fetch(
      `${API_BASE}/files/${key.split('/').map(encodeURIComponent).join('/')}`,
      {
        headers: { authorization: `Bearer ${token}` },
        credentials: 'omit',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    await putFile(db.tenantId, key, blob);
    return blob;
  } catch {
    return null;
  }
}

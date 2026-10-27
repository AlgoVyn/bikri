/** File queue upload and download (T-033, 04 §3.5–3.6). R2 keys get the tenant prefix on the server. */
import { API_BASE } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { putFile } from '../data/fileCache.ts';
import { deviceToken, OfflineError, SyncHttpError } from './client.ts';

/** Uploads pending photos/logos; a 4xx marks the entry failed, network errors leave it pending. */
export async function uploadQueued(db: BikriDb, max = 10): Promise<number> {
  const token = await deviceToken(db);
  if (!token) return 0;
  const pending = (
    await db.file_queue.where('status').equals('pending').toArray()
  ).slice(0, max);
  let done = 0;
  for (const e of pending) {
    if (e.id === undefined) continue;
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
          },
          body: e.blob,
          credentials: 'omit',
        },
      );
    } catch (error) {
      throw new OfflineError(error);
    }
    if (res.ok) {
      await db.file_queue.delete(e.id);
      done += 1;
      continue;
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code ?? 'HTTP_ERROR';
    if (
      res.status >= 500 ||
      code === 'TENANT_READ_ONLY' ||
      code === 'TENANT_QUOTA'
    ) {
      throw new SyncHttpError(
        code,
        res.status,
        body?.error?.message ?? '',
        {},
        null,
      );
    }
    await db.file_queue.update(e.id, { status: 'failed' });
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

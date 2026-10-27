/**
 * Local copies of shop files (01 §PWA): Cache Storage `bikri-files`, cache-first, max 2,000
 * entries (oldest dropped). Keys carry the tenant so two shops on one browser never share a
 * photo even when their relative keys collide (D-073, D-092). T-033 fills it from the server.
 */
export const FILE_CACHE = 'bikri-files';
export const FILE_CACHE_MAX = 2000;

/** Synthetic request URL for a tenant's relative key (never fetched from the network). */
export function fileCacheUrl(tenantId: string, key: string): string {
  return new URL(
    `/bikri/__files/${encodeURIComponent(tenantId)}/${key}`,
    'https://bikri.local',
  ).href;
}

function storage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

export async function putFile(
  tenantId: string,
  key: string,
  blob: Blob,
): Promise<void> {
  const store = storage();
  if (!store) return;
  const cache = await store.open(FILE_CACHE);
  await cache.put(
    fileCacheUrl(tenantId, key),
    new Response(await blob.arrayBuffer(), {
      headers: { 'content-type': blob.type || 'application/octet-stream' },
    }),
  );
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - FILE_CACHE_MAX)))
    await cache.delete(old);
}

export async function getFile(
  tenantId: string,
  key: string,
): Promise<Blob | null> {
  const store = storage();
  if (!store) return null;
  const cache = await store.open(FILE_CACHE);
  const hit = await cache.match(fileCacheUrl(tenantId, key));
  return hit ? hit.blob() : null;
}

export async function deleteFile(tenantId: string, key: string): Promise<void> {
  const store = storage();
  if (!store) return;
  const cache = await store.open(FILE_CACHE);
  await cache.delete(fileCacheUrl(tenantId, key));
}

/** "Leave this shop" (T-034): drop one tenant's cached files only. */
export async function clearTenantFiles(tenantId: string): Promise<void> {
  const store = storage();
  if (!store) return;
  const cache = await store.open(FILE_CACHE);
  const prefix = fileCacheUrl(tenantId, '');
  for (const req of await cache.keys())
    if (req.url.startsWith(prefix)) await cache.delete(req);
}

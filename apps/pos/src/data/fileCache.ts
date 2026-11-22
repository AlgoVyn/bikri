import { BASE_PATH } from '@bikri/core';

/**
 * Local copies of shop files (01 §PWA): Cache Storage `bikri-files`, cache-first, max 2,000
 * entries (oldest dropped). Keys carry the tenant so two shops on one browser never share a
 * photo even when their relative keys collide (D-073, D-092). T-033 fills it from the server.
 */
export const FILE_CACHE = 'bikri-files';
export const FILE_CACHE_MAX = 2000;

/** `cache.keys()` walks every entry; prune once per session and then every 50 puts. */
let putsSincePrune = 0;
const PRUNE_EVERY = 50;

async function pruneFileCache(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - FILE_CACHE_MAX)))
    await cache.delete(old);
}

/** Synthetic request URL for a tenant's relative key (never fetched from the network). */
export function fileCacheUrl(tenantId: string, key: string): string {
  const path = key
    .split('/')
    .map((segment) => {
      if (segment === '.' || segment === '..')
        throw new Error('invalid file key');
      return encodeURIComponent(segment);
    })
    .join('/');
  return new URL(
    `${BASE_PATH}/__files/${encodeURIComponent(tenantId)}/${path}`,
    'https://bikri.local',
  ).href;
}

function storage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

/**
 * `caches.open` per put/get was a needless promise + lookup on every photo. Keyed by
 * the CacheStorage object so a test or browser swap never reuses the old cache.
 */
const CACHE_STORES = new WeakMap<CacheStorage, Map<string, Promise<Cache>>>();
function fileCacheStore(): Promise<Cache> | null {
  const store = storage();
  if (!store) return null;
  let byName = CACHE_STORES.get(store);
  if (byName === undefined) {
    byName = new Map();
    CACHE_STORES.set(store, byName);
  }
  let pending = byName.get(FILE_CACHE);
  if (pending === undefined) {
    pending = store.open(FILE_CACHE);
    byName.set(FILE_CACHE, pending);
    // A rejection (quota, private mode, a closed cache) must not be cached for the
    // page's lifetime: drop it so the next put/get can retry (SYNC-L4).
    void pending.catch(() => {
      if (byName?.get(FILE_CACHE) === pending) byName.delete(FILE_CACHE);
    });
  }
  return pending;
}

/**
 * Object URLs are content-addressed, so one URL per distinct photo can be reused
 * instead of re-reading Cache Storage on every virtualized tile mount. Keep a bounded
 * LRU: every URL retains its Blob in memory, and 2,000 photos × up to 150 KB could
 * otherwise reach the app's whole 300 MB memory budget (D-231).
 */
export const FILE_URL_CACHE_MAX = 200;
const FILE_URLS = new Map<string, Promise<string | null>>();

function revokeWhenReady(pending: Promise<string | null>): void {
  void pending
    .then((url) => {
      if (url) URL.revokeObjectURL(url);
    })
    .catch(() => undefined);
}

function evictOldestUrl(): void {
  while (FILE_URLS.size > FILE_URL_CACHE_MAX) {
    const oldest = FILE_URLS.keys().next().value;
    if (oldest === undefined) return;
    const pending = FILE_URLS.get(oldest);
    FILE_URLS.delete(oldest);
    if (pending !== undefined) revokeWhenReady(pending);
  }
}

export function fileUrlFor(
  tenantId: string,
  key: string,
  load: () => Promise<Blob | null>,
): Promise<string | null> {
  const cacheKey = `${tenantId}\u0000${key}`;
  const cached = FILE_URLS.get(cacheKey);
  if (cached !== undefined) {
    // A Map keeps insertion order; re-inserting marks this URL as most recently used.
    FILE_URLS.delete(cacheKey);
    FILE_URLS.set(cacheKey, cached);
    return cached;
  }
  const pending = load()
    .then((blob) => {
      if (!blob) {
        // A missing file may be uploaded or pulled later; do not cache the miss.
        FILE_URLS.delete(cacheKey);
        return null;
      }
      return URL.createObjectURL(blob);
    })
    .catch((error: unknown) => {
      // A transient CacheStorage/network failure must not poison later mounts.
      FILE_URLS.delete(cacheKey);
      throw error;
    });
  FILE_URLS.set(cacheKey, pending);
  evictOldestUrl();
  return pending;
}

export function clearFileUrls(tenantId?: string): void {
  const prefix = tenantId === undefined ? null : `${tenantId}\u0000`;
  for (const [key, pending] of FILE_URLS) {
    if (prefix !== null && !key.startsWith(prefix)) continue;
    FILE_URLS.delete(key);
    revokeWhenReady(pending);
  }
}

export async function putFile(
  tenantId: string,
  key: string,
  blob: Blob,
): Promise<void> {
  const cache = await fileCacheStore();
  if (!cache) return;
  await cache.put(
    fileCacheUrl(tenantId, key),
    new Response(await blob.arrayBuffer(), {
      headers: { 'content-type': blob.type || 'application/octet-stream' },
    }),
  );
  // Listing the cache on every image put is O(n) per image; at 2,000 entries a
  // 1,000-photo import walked the whole cache 1,000 times. Prune periodically.
  if (putsSincePrune % PRUNE_EVERY === 0) await pruneFileCache(cache);
  putsSincePrune += 1;
}

export async function getFile(
  tenantId: string,
  key: string,
): Promise<Blob | null> {
  const cache = await fileCacheStore();
  if (!cache) return null;
  const hit = await cache.match(fileCacheUrl(tenantId, key));
  return hit ? hit.blob() : null;
}

export async function deleteFile(tenantId: string, key: string): Promise<void> {
  const cache = await fileCacheStore();
  if (!cache) return;
  await cache.delete(fileCacheUrl(tenantId, key));
}

/** "Leave this shop" (T-034): drop one tenant's cached files only. */
export async function clearTenantFiles(tenantId: string): Promise<void> {
  clearFileUrls(tenantId);
  const cache = await fileCacheStore();
  if (!cache) return;
  const prefix = fileCacheUrl(tenantId, '');
  const keys = (await cache.keys()).filter((req) => req.url.startsWith(prefix));
  await Promise.all(keys.map((req) => cache.delete(req)));
}

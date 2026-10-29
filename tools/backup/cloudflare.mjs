/**
 * Shared Cloudflare R2 helpers for the backup tools (docs/09).
 *
 * The API token only needs R2 read on the buckets the tools touch. Object keys are sent with
 * literal slashes (the R2 API rejects `%2F`), and errors never echo a key because keys contain
 * tenant ids.
 */
const API = 'https://api.cloudflare.com/client/v4';

export function r2Auth(env = process.env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token)
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required',
    );
  return { account, token };
}

export async function cloudflareJson(
  path,
  { method = 'GET', auth = r2Auth() } = {},
) {
  const res = await fetch(`${API}/accounts/${auth.account}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth.token}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const message = body?.errors?.[0]?.message ?? res.statusText;
    throw new Error(`Cloudflare API ${res.status}: ${message}`);
  }
  return body;
}

/** Every object under `prefix`, following the cursor until the listing is complete. */
export async function listObjects(bucket, prefix, auth = r2Auth()) {
  const objects = [];
  let cursor = '';
  for (let guard = 0; guard < 10_000; guard += 1) {
    const query = new URLSearchParams({ prefix, per_page: '1000' });
    if (cursor) query.set('cursor', cursor);
    const page = await cloudflareJson(
      `/r2/buckets/${encodeURIComponent(bucket)}/objects?${query.toString()}`,
      { auth },
    );
    for (const object of page.result ?? []) objects.push(object);
    const next = page.result_info?.cursor;
    if (!page.result_info?.is_truncated || !next) return objects;
    cursor = next;
  }
  throw new Error('R2 object listing did not finish');
}

/** R2 requires `/` to stay literal; everything else is percent-encoded per segment. */
export function objectPath(bucket, key) {
  return `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export class R2DownloadError extends Error {
  constructor(status) {
    super(`R2 object download failed (HTTP ${status})`);
    this.name = 'R2DownloadError';
    this.status = status;
  }
}

export async function downloadObject(bucket, key, auth = r2Auth()) {
  const res = await fetch(
    `${API}/accounts/${auth.account}${objectPath(bucket, key)}`,
    {
      headers: { authorization: `Bearer ${auth.token}` },
    },
  );
  if (!res.ok) throw new R2DownloadError(res.status);
  return new Uint8Array(await res.arrayBuffer());
}

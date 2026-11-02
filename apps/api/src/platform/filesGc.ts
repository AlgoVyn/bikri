/** Safe per-tenant R2 orphan cleanup (operator action, docs/09). */
import { tenantDb } from '../db/tenantDb.ts';
import type { TenantRow } from '../types.ts';

const KEEP_UNREFERENCED_MS = 24 * 60 * 60 * 1000;
const DELETE_BATCH = 1_000;

export type FileGcResult = {
  examined: number;
  unreferenced: number;
  deleted: number;
  bytes: number;
};

/**
 * Deletes R2 objects under `t/<tenant>/` that no current product or shop row references.
 * New objects are kept for 24 h so an upload cannot be removed between the PUT and the
 * product/shop row that points at it reaching D1.
 */
export async function gcTenantFiles(
  env: Env,
  tenant: TenantRow,
  options: { now?: number; dryRun?: boolean } = {},
): Promise<FileGcResult> {
  const db = tenantDb(env, tenant);
  const [products, shop] = await db.batch([
    db.prepare(
      'SELECT image_key FROM products WHERE tenant_id = ?1 AND image_key IS NOT NULL',
    ),
    db.prepare(
      'SELECT logo_key FROM shop WHERE tenant_id = ?1 AND logo_key IS NOT NULL',
    ),
  ]);
  const referenced = new Set<string>();
  for (const row of (products?.results ?? []) as { image_key: string }[])
    referenced.add(row.image_key);
  for (const row of (shop?.results ?? []) as { logo_key: string }[])
    referenced.add(row.logo_key);

  const prefix = `t/${tenant.id}/`;
  const objects: { key: string; size: number; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({
      prefix,
      ...(cursor ? { cursor } : {}),
      limit: 1_000,
    });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const cutoff = (options.now ?? Date.now()) - KEEP_UNREFERENCED_MS;
  const stale = objects.filter(
    (object) =>
      object.uploaded.getTime() <= cutoff &&
      !referenced.has(object.key.slice(prefix.length)),
  );
  const bytes = stale.reduce((sum, object) => sum + object.size, 0);
  if (!options.dryRun) {
    for (let at = 0; at < stale.length; at += DELETE_BATCH)
      await env.FILES.delete(
        stale.slice(at, at + DELETE_BATCH).map((o) => o.key),
      );
  }
  return {
    examined: objects.length,
    unreferenced: stale.length,
    deleted: options.dryRun ? 0 : stale.length,
    bytes,
  };
}

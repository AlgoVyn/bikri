/**
 * Per-shop R2 usage accounting (D-226).
 *
 * Raw `env.DB` is allowed in platform/ (13 §5); the upload route calls these helpers so
 * it never reaches the database binding directly. `tenants` is a platform table, and
 * every statement names the tenant.
 */
export const MAX_TENANT_FILE_BYTES = 1_000_000_000;

/**
 * Sums the tenant prefix once, then marks the shop initialized. A concurrent upload can
 * win the same race; the conditional update makes the second a no-op and the reservation
 * below is still atomic.
 */
export async function initializeFileUsage(
  env: Env,
  tenantId: string,
): Promise<void> {
  let used = 0;
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({
      prefix: `t/${tenantId}/`,
      ...(cursor ? { cursor } : {}),
      limit: 1000,
    });
    for (const object of page.objects) used += object.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.prepare(
    'UPDATE tenants SET file_bytes = ?2, files_initialized = 1 WHERE id = ?1 AND files_initialized = 0',
  )
    .bind(tenantId, used)
    .run();
}

/** Reserves bytes against the cap before the R2 PUT; false means the shop is full. */
export async function reserveFileBytes(
  env: Env,
  tenantId: string,
  bytes: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE tenants SET file_bytes = file_bytes + ?2 WHERE id = ?1 AND file_bytes + ?2 <= ?3',
  )
    .bind(tenantId, bytes, MAX_TENANT_FILE_BYTES)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function releaseFileBytes(
  env: Env,
  tenantId: string,
  bytes: number,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE tenants SET file_bytes = MAX(0, file_bytes - ?2) WHERE id = ?1',
  )
    .bind(tenantId, bytes)
    .run();
}

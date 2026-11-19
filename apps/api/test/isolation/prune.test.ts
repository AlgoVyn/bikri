import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { pruneAll } from '../../src/platform/prune.ts';
import {
  addBundleFixture,
  addSupportDevice,
  api,
  IDS,
  json,
  seedShop,
  setStatus,
} from '../helpers/fixtures.ts';
import { pullAll, pushOk, saleOps } from '../helpers/ops.ts';

const DAY = 86_400_000;
const n = async (sql: string, ...p: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...p)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

describe('prune cron (03 §4.4; 16, I12, I16)', () => {
  it('16 / I12: per-tenant floors, applied_ops 90 days, second run deletes nothing, B never 410 for A', async () => {
    const a = await seedShop('Prune A');
    const b = await seedShop('Prune B');
    await pushOk(a.till, saleOps(a, a.till, 1));
    await pushOk(b.till, saleOps(b, b.till, 1));
    const now = Date.now();
    // Age every A row and half of B's.
    await env.DB.prepare('UPDATE change_log SET at = ?2 WHERE tenant_id = ?1')
      .bind(a.tenantId, now - 40 * DAY)
      .run();
    const bMax = await n(
      'SELECT MAX(seq) AS n FROM change_log WHERE tenant_id = ?1',
      b.tenantId,
    );
    const bMin = await n(
      'SELECT MIN(seq) AS n FROM change_log WHERE tenant_id = ?1',
      b.tenantId,
    );
    await env.DB.prepare(
      'UPDATE change_log SET at = ?2 WHERE tenant_id = ?1 AND seq = ?3',
    )
      .bind(b.tenantId, now - 40 * DAY, bMin)
      .run();
    await env.DB.prepare(
      'UPDATE applied_ops SET applied_at = ?2 WHERE tenant_id = ?1',
    )
      .bind(a.tenantId, now - 100 * DAY)
      .run();
    const aMax = await n(
      'SELECT MAX(seq) AS n FROM change_log WHERE tenant_id = ?1',
      a.tenantId,
    );

    const report = await pruneAll(env, now);
    expect(report.calls).toBeLessThanOrEqual(50);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(0);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = ?1',
        b.tenantId,
      ),
    ).toBeGreaterThan(0);
    expect(
      await n(
        'SELECT change_log_floor AS n FROM tenants WHERE id = ?1',
        a.tenantId,
      ),
    ).toBe(aMax);
    expect(
      await n(
        'SELECT change_log_floor AS n FROM tenants WHERE id = ?1',
        b.tenantId,
      ),
    ).toBe(bMin);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM applied_ops WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(0);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM applied_ops WHERE tenant_id = ?1',
        b.tenantId,
      ),
    ).toBeGreaterThan(0);

    const again = await pruneAll(env, now);
    expect(Object.values(again.change_log).reduce((x, y) => x + y, 0)).toBe(0);

    // A's old cursor gets 410; B pulling from its own floor does not.
    const gone = await api('/sync/pull?since=0', { token: a.till.token });
    expect(gone.status).toBe(410);
    expect(
      (
        await json<{
          error: { code: string; details: { change_log_floor: number } };
        }>(gone)
      ).error,
    ).toMatchObject({
      code: 'SNAPSHOT_REQUIRED',
      details: { change_log_floor: aMax },
    });
    expect(
      (await api(`/sync/pull?since=${bMin}`, { token: b.till.token })).status,
    ).toBe(200);
    const bChanges = await pullAll(b.till, bMin);
    expect(bChanges.at(-1)?.seq).toBe(bMax);
    // A's snapshot starts from its floor when it has no log rows
    const snap = await json<{ snapshot_seq: number }>(
      await api('/sync/snapshot', { token: a.till.token }),
    );
    expect(snap.snapshot_seq).toBe(aMax);
  });

  it('prunes more than 5,000 applied_ops so 90-day retention can be met', async () => {
    const shop = await seedShop('Prune many');
    const old = Date.now() - 100 * DAY;
    for (let batch = 0; batch < 6; batch += 1) {
      await env.DB.prepare(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000)
         INSERT INTO applied_ops (tenant_id, op_id, device_id, applied_at, result, error_code)
         SELECT ?1, 'old-' || ?2 || '-' || x, ?3, ?4, 'applied', NULL FROM c`,
      )
        .bind(shop.tenantId, batch, shop.till.id, old)
        .run();
    }
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM applied_ops WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(6_000);
    const report = await pruneAll(env, Date.now());
    expect(report.applied_ops).toBeGreaterThanOrEqual(6_000);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM applied_ops WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(0);
  });

  it('I16: deleting D removes only D rows and t/<D>/ objects; then D is a tombstone', async () => {
    const a = await seedShop('Del A');
    const d = await seedShop('Del D');
    await addBundleFixture(d, 'D');
    await pushOk(d.till, saleOps(d, d.till, 1));
    await pushOk(a.till, saleOps(a, a.till, 1));
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO owner_email_codes (tenant_id, id, device_id, staff_id, code_hash, created_at, expires_at)
       VALUES (?1, 'del-owner-code', ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        d.tenantId,
        d.till.id,
        IDS.owner,
        'f'.repeat(64),
        now,
        now + 600_000,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO shop_requests (id, shop_name, owner_name, email, status, tenant_id, created_at, updated_at)
       VALUES ('del-request', 'Del D', 'Owner', 'del-d@example.com', 'approved', ?1, ?2, ?2)`,
    )
      .bind(d.tenantId, now)
      .run();
    await env.FILES.put(`t/${d.tenantId}/shop/logo-x.png`, 'x');
    await env.FILES.put(`t/${a.tenantId}/shop/logo-x.png`, 'x');
    const aBefore = await n(
      'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
      a.tenantId,
    );
    await setStatus(d.tenantId, 'deleting');
    for (let i = 0; i < 5; i += 1) await pruneAll(env, Date.now());
    const tenant = await env.DB.prepare(
      'SELECT status, owner_email, deleted_at FROM tenants WHERE id = ?1',
    )
      .bind(d.tenantId)
      .first<{
        status: string;
        owner_email: string | null;
        deleted_at: number;
      }>();
    expect(tenant?.status).toBe('deleted');
    expect(tenant?.owner_email).toBeNull();
    for (const tbl of [
      'sales',
      'sale_lines',
      'products',
      'bundle_items',
      'devices',
      'change_log',
      'applied_ops',
      'branches',
      'shop',
      'staff',
      'enrolment_codes',
      'owner_email_codes',
      'tenant_usage',
    ]) {
      expect(
        await n(
          `SELECT COUNT(*) AS n FROM ${tbl} WHERE tenant_id = ?1`,
          d.tenantId,
        ),
        tbl,
      ).toBe(0);
    }
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM shop_requests WHERE tenant_id = ?1',
        d.tenantId,
      ),
    ).toBe(0);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(aBefore);
    expect(await env.FILES.head(`t/${d.tenantId}/shop/logo-x.png`)).toBeNull();
    expect(
      await env.FILES.head(`t/${a.tenantId}/shop/logo-x.png`),
    ).not.toBeNull();
  });

  it('ends expired support access once, with an audit row, without touching another tenant', async () => {
    const now = Date.now();
    const a = await seedShop('Sup cron');
    const b = await seedShop('Sup cron B');
    await addSupportDevice(a, now - 1);
    const liveB = await addSupportDevice(b, now + 3_600_000);
    await env.DB.prepare(
      "UPDATE tenants SET support_until = ?2, support_reason = 'x' WHERE id = ?1",
    )
      .bind(a.tenantId, now - 1)
      .run();
    await env.DB.prepare(
      "UPDATE tenants SET support_until = ?2, support_reason = 'y' WHERE id = ?1",
    )
      .bind(b.tenantId, now + 3_600_000)
      .run();
    const r = await pruneAll(env, now);
    expect(r.support_ended).toContain(a.tenantId);
    expect(r.support_ended).not.toContain(b.tenantId);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?1 AND action = 'support_access_end'",
        a.tenantId,
      ),
    ).toBe(1);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?1 AND action = 'support_access_end'",
        b.tenantId,
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT revoked_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(b.tenantId, liveB.id)
        .first<{ revoked_at: number | null }>(),
    ).toEqual({ revoked_at: null });
    const r2 = await pruneAll(env, now);
    expect(r2.support_ended).not.toContain(a.tenantId);
  });

  it('prunes expired codes and old requests without touching fresh rows', async () => {
    const shop = await seedShop('Retention');
    const other = await seedShop('Retention other');
    const now = Date.now();
    const old = now - 100 * DAY;
    await env.DB.prepare(
      `INSERT INTO enrolment_codes (code_hash, tenant_id, device_name, branch_id, grants_admin, created_by, created_at, expires_at)
       VALUES ('old-code', ?1, 'Old', ?2, 0, 'test', ?3, ?3)`,
    )
      .bind(shop.tenantId, shop.branchId, old)
      .run();
    await env.DB.prepare(
      `INSERT INTO enrolment_codes (code_hash, tenant_id, device_name, branch_id, grants_admin, created_by, created_at, expires_at)
       VALUES ('fresh-code', ?1, 'Fresh', ?2, 0, 'test', ?3, ?4)`,
    )
      .bind(shop.tenantId, shop.branchId, now, now + 600_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO owner_email_codes (tenant_id, id, device_id, staff_id, code_hash, created_at, expires_at)
       VALUES (?1, 'old-owner', ?2, ?3, 'old-owner-hash', ?4, ?4)`,
    )
      .bind(shop.tenantId, shop.till.id, IDS.owner, old)
      .run();
    await env.DB.prepare(
      `INSERT INTO owner_email_codes (tenant_id, id, device_id, staff_id, code_hash, created_at, expires_at)
       VALUES (?1, 'fresh-owner', ?2, ?3, 'fresh-owner-hash', ?4, ?5)`,
    )
      .bind(shop.tenantId, shop.till.id, IDS.owner, now, now + 600_000)
      .run();
    const oldDay = new Date(old).toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO tenant_usage (tenant_id, day, pushes, rows_written, rows_read) VALUES (?1, ?2, 0, 0, 0)',
    )
      .bind(other.tenantId, oldDay)
      .run();
    await env.DB.prepare(
      `INSERT INTO shop_requests (id, shop_name, owner_name, email, status, created_at, updated_at)
       VALUES ('old-rejected', 'Old', 'Owner', 'old-rejected@example.com', 'rejected', ?1, ?1)`,
    )
      .bind(old)
      .run();
    await env.DB.prepare(
      `INSERT INTO shop_requests (id, shop_name, owner_name, email, status, created_at, updated_at)
       VALUES ('fresh-rejected', 'Fresh', 'Owner', 'fresh-rejected@example.com', 'rejected', ?1, ?1)`,
    )
      .bind(now)
      .run();

    await pruneAll(env, now);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM enrolment_codes WHERE code_hash = 'old-code'",
      ),
    ).toBe(0);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM enrolment_codes WHERE code_hash = 'fresh-code'",
      ),
    ).toBe(1);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM owner_email_codes WHERE id = 'old-owner'",
      ),
    ).toBe(0);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM owner_email_codes WHERE id = 'fresh-owner'",
      ),
    ).toBe(1);
    expect(
      await n(
        'SELECT COUNT(*) AS n FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
        other.tenantId,
        oldDay,
      ),
    ).toBe(0);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM shop_requests WHERE id = 'old-rejected'",
      ),
    ).toBe(0);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM shop_requests WHERE id = 'fresh-rejected'",
      ),
    ).toBe(1);
  });
});

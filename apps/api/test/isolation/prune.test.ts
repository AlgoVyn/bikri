import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { pruneAll } from '../../src/platform/prune.ts';
import {
  addSupportDevice,
  api,
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
    expect(report.calls).toBeLessThanOrEqual(40);
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

  it('I16: deleting D removes only D rows and t/<D>/ objects; then D is a tombstone', async () => {
    const a = await seedShop('Del A');
    const d = await seedShop('Del D');
    await pushOk(d.till, saleOps(d, d.till, 1));
    await pushOk(a.till, saleOps(a, a.till, 1));
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
      'products',
      'devices',
      'change_log',
      'branches',
      'shop',
      'staff',
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
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        a.tenantId,
      ),
    ).toBe(aBefore);
    expect(await env.FILES.head(`t/${d.tenantId}/shop/logo-x.png`)).toBeNull();
    expect(
      await env.FILES.head(`t/${a.tenantId}/shop/logo-x.png`),
    ).not.toBeNull();
  });

  it('ends expired support access once, with an audit row', async () => {
    const a = await seedShop('Sup cron');
    await addSupportDevice(a, Date.now() - 1);
    await env.DB.prepare(
      "UPDATE tenants SET support_until = ?2, support_reason = 'x' WHERE id = ?1",
    )
      .bind(a.tenantId, Date.now() - 1)
      .run();
    const r = await pruneAll(env, Date.now());
    expect(r.support_ended).toContain(a.tenantId);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?1 AND action = 'support_access_end'",
        a.tenantId,
      ),
    ).toBe(1);
    const r2 = await pruneAll(env, Date.now());
    expect(r2.support_ended).not.toContain(a.tenantId);
  });
});

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, json, seedShop } from '../helpers/fixtures.ts';

const CONFLICT_ID = '01JC0000000000000000000F1';
const EXTRA_ID = '01JC0000000000000000000F3';
const OP_ID = '01JC0000000000000000000F2';

async function conflict(tenantId: string, id = CONFLICT_ID): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) VALUES (?1, ?2, ?3, 'sales', 'row', 'over_refund', '{}', 'needs_owner', ?4)",
  )
    .bind(tenantId, id, OP_ID, Date.now())
    .run();
}

describe('operator usage isolation (13 §5, 10 §8)', () => {
  it('reports colliding conflict ids per shop, never merged', async () => {
    const a = await seedShop('Usage A');
    const b = await seedShop('Usage B');
    await conflict(a.tenantId);
    await conflict(a.tenantId, EXTRA_ID);
    await conflict(b.tenantId);

    const usage = await json<{
      open_conflicts: { tenant_id: string; count: number }[];
    }>(await api('/admin/usage'));

    const forA = usage.open_conflicts.filter(
      (row) => row.tenant_id === a.tenantId,
    );
    const forB = usage.open_conflicts.filter(
      (row) => row.tenant_id === b.tenantId,
    );
    expect(forA).toEqual([{ tenant_id: a.tenantId, count: 2 }]);
    expect(forB).toEqual([{ tenant_id: b.tenantId, count: 1 }]);
  });
});

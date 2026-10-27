import { env } from 'cloudflare:workers';
import { TABLE_COLUMNS } from '@bikri/db/tables';
import { describe, expect, it } from 'vitest';
import { rowJsonExpr } from '../src/sync/tables.ts';

describe('packages/db/src/tables.ts', () => {
  it('matches the migrated D1 schema column for column', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name).sort();
    expect(tables).toEqual(Object.keys(TABLE_COLUMNS).sort());
    for (const tbl of tables) {
      const cols = await env.DB.prepare(
        'SELECT name FROM pragma_table_info(?1)',
      )
        .bind(tbl)
        .all<{ name: string }>();
      expect(
        cols.results.map((c) => c.name),
        tbl,
      ).toEqual([...TABLE_COLUMNS[tbl as keyof typeof TABLE_COLUMNS]]);
    }
  });

  it('builds row JSON within the 32-argument limit and keeps nulls', async () => {
    const expr = rowJsonExpr('sales');
    for (const call of expr.matchAll(/json_(?:object|insert)\(/g))
      expect(call).toBeTruthy();
    const row = await env.DB.prepare(
      `SELECT ${rowJsonExpr('devices')} AS j FROM (SELECT 'id1' AS id, 'n' AS name, 'b' AS branch_id, 'A' AS device_code, 0 AS is_admin, 'till' AS kind, NULL AS expires_at, NULL AS read_only_seen_at, 1 AS enrolled_at, 'x' AS enrolled_by, NULL AS revoked_at, NULL AS last_seen_at, 0 AS last_invoice_seq, 0 AS pending_ops, NULL AS oldest_pending_at, NULL AS user_agent, NULL AS app_version, 1 AS created_at, 2 AS updated_at)`,
    ).first<{ j: string }>();
    const parsed = JSON.parse(row?.j ?? '{}');
    expect(parsed).toHaveProperty('revoked_at', null);
    expect(parsed).toHaveProperty('updated_at', 2);
    expect(parsed).not.toHaveProperty('token_hash');
  });
});

describe('APPLY_ORDER', () => {
  it('lists parents before children for every synced foreign key', async () => {
    const { APPLY_ORDER } = await import('../src/sync/tables.ts');
    const rank = new Map<string, number>(APPLY_ORDER.map((t, i) => [t, i]));
    for (const tbl of APPLY_ORDER) {
      const fks = await env.DB.prepare(
        'SELECT "table" AS parent FROM pragma_foreign_key_list(?1)',
      )
        .bind(tbl)
        .all<{ parent: string }>();
      for (const { parent } of fks.results) {
        if (parent === 'tenants' || parent === tbl || parent === 'devices')
          continue;
        expect(rank.get(parent), `${tbl} → ${parent}`).toBeLessThan(
          rank.get(tbl) ?? -1,
        );
      }
    }
  });
});

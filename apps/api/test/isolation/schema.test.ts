import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TABLES, TENANT_TABLES } from '../../src/db/tenantDb.ts';

// I20 (10 §8): every tenant table carries tenant_id, is keyed by it, references other tenant
// tables only through composite foreign keys, and every index leads with tenant_id.

const db = env.DB;

/** Tables whose primary key is a server-made, globally unique value (02 §2). */
const PK_EXCEPTIONS: Record<string, string[]> = {
  change_log: ['seq'], // AUTOINCREMENT stream per database; readers filter by (tenant_id, seq)
  enrolment_codes: ['code_hash'], // the code itself identifies the tenant (D-072)
  applied_ops: ['tenant_id', 'op_id'],
};
/** Cross-tenant indexes allowed by 10 §8 I20, plus globally unique secrets. */
const INDEX_EXCEPTIONS = new Set(['change_log_at', 'applied_ops_at']);
const UNIQUE_EXCEPTIONS: Record<string, string[]> = {
  devices: ['token_hash'], // globally unique, identifies the tenant (02 §2)
  enrolment_codes: ['code_hash'],
};

type ColumnInfo = { name: string; pk: number };
type FkInfo = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
};
type IndexInfo = { name: string; origin: string; unique: number };

async function pragma<T>(sql: string): Promise<T[]> {
  const { results } = await db.prepare(sql).all<T>();
  return results;
}

async function indexColumns(index: string): Promise<string[]> {
  const cols = await pragma<{ seqno: number; name: string }>(
    `PRAGMA index_info('${index}')`,
  );
  return cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
}

describe('I20 schema check', () => {
  it('knows every table as either platform or tenant', async () => {
    const { results } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      [...PLATFORM_TABLES, ...TENANT_TABLES].sort(),
    );
  });

  for (const table of TENANT_TABLES) {
    it(`${table}: tenant_id, tenant-leading key, composite FKs, tenant-leading indexes`, async () => {
      const cols = await pragma<ColumnInfo>(`PRAGMA table_info('${table}')`);
      expect(
        cols.some((c) => c.name === 'tenant_id'),
        `${table} has no tenant_id`,
      ).toBe(true);

      const pk = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pk, `${table} primary key`).toEqual(
        PK_EXCEPTIONS[table] ?? ['tenant_id', 'id'],
      );

      const fks = await pragma<FkInfo>(`PRAGMA foreign_key_list('${table}')`);
      const byId = new Map<number, FkInfo[]>();
      for (const fk of fks) byId.set(fk.id, [...(byId.get(fk.id) ?? []), fk]);
      for (const parts of byId.values()) {
        const parent = parts[0]?.table ?? '';
        const from = parts.sort((a, b) => a.seq - b.seq).map((p) => p.from);
        if (parent === 'tenants') {
          expect(from, `${table} → tenants`).toEqual(['tenant_id']);
          continue;
        }
        expect(
          (TENANT_TABLES as readonly string[]).includes(parent),
          `${table} references non-tenant table ${parent}`,
        ).toBe(true);
        expect(from[0], `${table} → ${parent} is not composite`).toBe(
          'tenant_id',
        );
        expect(parts[0]?.to, `${table} → ${parent} target`).toBe('tenant_id');
        expect(from.length, `${table} → ${parent}`).toBe(2);
      }
      expect(
        [...byId.values()].some((p) => p[0]?.table === 'tenants'),
        `${table} must reference tenants(id)`,
      ).toBe(true);

      const indexes = await pragma<IndexInfo>(`PRAGMA index_list('${table}')`);
      for (const idx of indexes) {
        if (INDEX_EXCEPTIONS.has(idx.name)) continue;
        const ic = await indexColumns(idx.name);
        if (idx.origin === 'pk' && PK_EXCEPTIONS[table]?.[0] !== 'tenant_id') {
          continue;
        }
        if (
          idx.origin === 'u' &&
          JSON.stringify(ic) === JSON.stringify(UNIQUE_EXCEPTIONS[table])
        ) {
          continue;
        }
        expect(ic[0], `${table} index ${idx.name} (${ic.join(', ')})`).toBe(
          'tenant_id',
        );
      }
    });
  }
});

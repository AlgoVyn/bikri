import { describe, expect, it } from 'vitest';
import { TABLE_COLUMNS } from '../../packages/db/src/tables.ts';
import {
  assertSqlDump,
  backupDate,
  buildManifest,
  countQueries,
  parseWranglerJson,
} from './export.mjs';
import { BACKUP_TABLES } from './tables.mjs';

const tenant = { id: 't1', slug: 'shop', status: 'active' };

describe('nightly D1 export', () => {
  it('uses the Asia/Karachi calendar date', () => {
    expect(backupDate(Date.parse('2026-10-27T21:30:00Z'))).toBe('2026-10-28');
    expect(backupDate(Date.parse('2026-10-27T18:00:00Z'))).toBe('2026-10-27');
  });

  it('parses wrangler JSON after a warning and rejects an empty dump', () => {
    expect(
      parseWranglerJson('warn\n[{"results":[{"id":"t1"}],"success":true}]'),
    ).toEqual([{ id: 't1' }]);
    expect(() => assertSqlDump('CREATE TABLE sales (id TEXT);')).toThrow(
      'smaller than 1 KB',
    );
    expect(() =>
      assertSqlDump(`${'x'.repeat(1100)}\nCREATE TABLE "sales" (id TEXT);`),
    ).not.toThrow();
    expect(() => assertSqlDump('x'.repeat(1100))).toThrow('CREATE TABLE sales');
  });

  it('keeps the table list in sync with the generated schema', () => {
    const expected = Object.keys(TABLE_COLUMNS).filter(
      (table) =>
        !['meta', 'tenants', 'expense_category_templates'].includes(table),
    );
    expect([...BACKUP_TABLES].sort()).toEqual(expected.sort());
  });

  it('builds per-tenant counts with every table present and zero-filled', () => {
    const manifest = buildManifest({
      date: '2026-10-28',
      tenants: [tenant],
      counts: [
        { tbl: 'sales', tenant_id: 't1', n: 3 },
        { tbl: 'expenses', tenant_id: 'other', n: 9 },
      ],
      sha256: 'abc',
    });
    expect(manifest).toMatchObject({
      date: '2026-10-28',
      sha256: 'abc',
      tenants: { t1: { slug: 'shop', status: 'active' } },
    });
    expect(manifest.tenants.t1.tables.sales).toBe(3);
    expect(manifest.tenants.t1.tables.expenses).toBe(0);
    expect(Object.keys(manifest.tenants.t1.tables)).toEqual(BACKUP_TABLES);
  });

  it('splits counts into compound queries D1 accepts', () => {
    const queries = countQueries();
    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries)
      expect(query.split(' UNION ALL ').length).toBeLessThanOrEqual(5);
  });
});

import { describe, expect, it } from 'vitest';
import {
  EXPORT_HIDDEN_COLUMNS,
  MONEY_FIELDS,
  TIME_FIELDS,
} from '../../packages/core/src/exportFields.ts';
import { TABLE_COLUMNS } from '../../packages/db/src/tables.ts';
import {
  assertSqlDump,
  backupDate,
  buildManifest,
  countDumpRows,
  parseWranglerJson,
} from './export.mjs';
import { BACKUP_TABLES, PLATFORM_TABLES } from './tables.mjs';

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
    const complete = [
      'x'.repeat(1100),
      ...['meta', 'tenants', ...BACKUP_TABLES, ...PLATFORM_TABLES].map(
        (table) => `CREATE TABLE "${table}" (id TEXT);`,
      ),
      "INSERT INTO tenants VALUES ('t1');",
    ].join('\n');
    expect(() => assertSqlDump(complete)).not.toThrow();
    expect(() => assertSqlDump('x'.repeat(1100))).toThrow('missing table');
    // A dump that stops after a few tables must not be accepted as complete.
    expect(() =>
      assertSqlDump(
        `${'x'.repeat(1100)}\nCREATE TABLE "sales" (id TEXT);\nINSERT INTO tenants VALUES ('t1');`,
      ),
    ).toThrow('missing table');
    expect(() =>
      assertSqlDump(complete.replace("INSERT INTO tenants VALUES ('t1');", '')),
    ).toThrow('tenant data');
  });

  it('keeps the table list in sync with the generated schema', () => {
    const expected = Object.keys(TABLE_COLUMNS).filter(
      (table) =>
        ![
          'meta',
          'tenants',
          'expense_category_templates',
          'shop_requests',
          'operator_audit',
        ].includes(table),
    );
    expect([...BACKUP_TABLES].sort()).toEqual(expected.sort());
  });

  it('classifies every money/time column and hides server-only fields', () => {
    const columns = new Set(Object.values(TABLE_COLUMNS).flat());
    for (const field of MONEY_FIELDS)
      expect(columns.has(field), `money field ${field}`).toBe(true);
    for (const field of TIME_FIELDS)
      expect(columns.has(field), `time field ${field}`).toBe(true);
    // A future `_at`/period column must be added to TIME_FIELDS, not left as epoch ms.
    for (const field of columns) {
      if (
        field === 'at' ||
        field.endsWith('_at') ||
        field === 'period_start' ||
        field === 'period_end'
      )
        expect(TIME_FIELDS.has(field), `time field ${field}`).toBe(true);
    }
    for (const [table, hidden] of Object.entries(EXPORT_HIDDEN_COLUMNS)) {
      expect(TABLE_COLUMNS[table], table).toBeDefined();
      for (const field of hidden)
        expect(TABLE_COLUMNS[table], `${table}.${field}`).toContain(field);
    }
    for (const field of [
      'bundle_discount_total',
      'bundle_price',
      'bundle_discount',
      'card_total',
      'bank_total',
      'udhaar_given',
    ])
      expect(MONEY_FIELDS.has(field), field).toBe(true);
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

  it('counts tenant rows from the dump instead of a second D1 pass', () => {
    const sql = [
      'CREATE TABLE "sales" (tenant_id TEXT, id TEXT, note TEXT);',
      `INSERT INTO "sales" ("tenant_id","id","note") VALUES('t1','s1','a, b (c); d');`,
      `INSERT INTO "sales" ("id","tenant_id") VALUES('s2','t1');`,
      `INSERT INTO "sales" ("tenant_id","id","note") VALUES('t1','s3','line\n two');`,
      `INSERT INTO "expenses" ("tenant_id","id") VALUES('t2','e1'),('t2','e2');`,
      `INSERT INTO "tenants" ("id") VALUES('t1');`,
    ].join('\n');
    expect(
      countDumpRows(sql).sort((a, b) =>
        `${a.tbl}:${a.tenant_id}`.localeCompare(`${b.tbl}:${b.tenant_id}`),
      ),
    ).toEqual([
      { tbl: 'expenses', tenant_id: 't2', n: 2 },
      { tbl: 'sales', tenant_id: 't1', n: 3 },
    ]);
  });

  it('ignores SQL comments that contain quotes or semicolons', () => {
    const sql = [
      `CREATE TABLE "sales" ( -- 'read_only' is a status; don't split`,
      ' tenant_id TEXT, id TEXT);',
      `INSERT INTO "sales" ("tenant_id","id") VALUES('t1','s1');`,
    ].join('\n');
    expect(countDumpRows(sql)).toEqual([
      { tbl: 'sales', tenant_id: 't1', n: 1 },
    ]);
  });

  it('refuses an unparseable INSERT for a tenant table', () => {
    expect(() => countDumpRows(`INSERT INTO "sales" VALUES('t1');`)).toThrow(
      'cannot parse INSERT for sales',
    );
    expect(() =>
      countDumpRows(`INSERT INTO "sales" ("tenant_id","id") VALUES('t1');`),
    ).toThrow('row has 1 values for 2 columns');
  });
});

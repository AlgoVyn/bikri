import { describe, expect, it } from 'vitest';
import { assertTenantScoped } from '../../src/db/tenantDb.ts';

// I19 (10 §8, 13 §5): SQL written in apps/api/src outside platform/ that touches a tenant
// table binds tenant_id = ?1, and nothing but db/tenantDb.ts and platform/ reaches env.DB.

const SOURCES: Record<string, string> = import.meta.glob('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const RAW_DB =
  /\b(?:env|c\.env|this\.env)\s*(?:\.\s*DB\b|\[\s*['"`]DB['"`]\s*\])|\bDB\s*\.\s*(?:prepare|batch|exec)\b/;
const SQL_LITERAL =
  /(['"`])((?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b(?:(?!\1)[\s\S])*)\1/gi;

function rel(path: string): string {
  return path.replace(/^(\.\.\/)+src\//, '');
}

const allowedRaw = (p: string): boolean =>
  p === 'db/tenantDb.ts' || p.startsWith('platform/');

/**
 * Interpolated SQL cannot be parsed for table names, but it must still bind the tenant.
 * The INSERT form is accepted because `tenantDb` prepends `(tenant_id, …) VALUES (?1, …)`.
 */
function interpolatedSqlScoped(sql: string): boolean {
  return (
    /\btenant_id\s*=\s*\?1\b/iu.test(sql) ||
    /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\S+\s*\(\s*tenant_id\s*,/iu.test(sql)
  );
}

/** SQL string literals in a source file (interpolated SQL is checked separately). */
function sqlLiterals(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SQL_LITERAL)) {
    const sql = m[2] ?? '';
    if (!/\b(FROM|INTO|UPDATE)\b/i.test(sql)) continue;
    if (m[1] === '`' && sql.includes('${')) continue;
    out.push(sql);
  }
  return out;
}

/** Interpolated SQL whose literal text does not bind the tenant. */
function unscopedInterpolated(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SQL_LITERAL)) {
    const sql = m[2] ?? '';
    if (m[1] !== '`' || !sql.includes('${')) continue;
    if (!/\b(FROM|INTO|UPDATE)\b/i.test(sql)) continue;
    if (!interpolatedSqlScoped(sql)) out.push(sql);
  }
  return out;
}

describe('I19 static check', () => {
  it('finds the API sources', () => {
    expect(Object.keys(SOURCES).map(rel)).toContain('db/tenantDb.ts');
  });

  it('uses env.DB only in db/tenantDb.ts and platform/', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([p, src]) => !allowedRaw(rel(p)) && RAW_DB.test(src))
      .map(([p]) => rel(p));
    expect(offenders).toEqual([]);
  });

  it('scopes every tenant-table statement outside platform/ to tenant_id = ?1', () => {
    const offenders: string[] = [];
    for (const [p, src] of Object.entries(SOURCES)) {
      const file = rel(p);
      if (file.startsWith('platform/') || file === 'db/tenantDb.ts') continue;
      for (const sql of sqlLiterals(src)) {
        try {
          assertTenantScoped(sql);
        } catch {
          offenders.push(`${file}: ${sql}`);
        }
      }
      for (const sql of unscopedInterpolated(src))
        offenders.push(
          `${file}: interpolated SQL without tenant_id = ?1: ${sql}`,
        );
    }
    expect(offenders).toEqual([]);
  });

  it('catches an unscoped statement and a raw DB call (self-test)', () => {
    const bad =
      "const r = await env.DB.prepare('SELECT * FROM products WHERE id = ?2');";
    expect(RAW_DB.test(bad)).toBe(true);
    expect(() => {
      for (const sql of sqlLiterals(bad)) assertTenantScoped(sql);
    }).toThrow(/tenant_id = \?1/);
    const good =
      "db.select('SELECT * FROM products WHERE tenant_id = ?1 AND id = ?2', id)";
    expect(RAW_DB.test(good)).toBe(false);
    for (const sql of sqlLiterals(good)) assertTenantScoped(sql);
    const placeholder = '$' + '{tbl}';
    expect(
      unscopedInterpolated(
        `db.prepare(\`SELECT * FROM ${placeholder} WHERE id = ?2\`)`,
      ),
    ).toHaveLength(1);
    expect(
      unscopedInterpolated(
        `db.prepare(\`SELECT * FROM ${placeholder} WHERE tenant_id = ?1 AND id = ?2\`)`,
      ),
    ).toHaveLength(0);
  });
});

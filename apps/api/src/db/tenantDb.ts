/**
 * The only way API code queries tenant tables (13 §5, D-070). Every statement binds the
 * caller's tenant id as `?1`; SQL that touches a tenant table without `tenant_id = ?1`
 * (or, for INSERT, a leading `tenant_id` column bound to `?1`) is refused before it runs.
 * Raw `env.DB` is allowed only here and in `src/platform/` (checked by test/isolation/static.test.ts).
 */

/** Platform tables: not tenant-scoped, primary database only (02 §1.1). */
export const PLATFORM_TABLES = [
  'meta',
  'tenants',
  'tenant_usage',
  'expense_category_templates',
] as const;

/** Every tenant-scoped D1 table (02 §1.1: server-owned, master, ledger). */
export const TENANT_TABLES = [
  'change_log',
  'applied_ops',
  'sync_conflicts',
  'devices',
  'enrolment_codes',
  'shop',
  'branches',
  'staff',
  'categories',
  'products',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'sales',
  'sale_lines',
  'payments',
  'refunds',
  'refund_lines',
  'sale_voids',
  'ledger_entries',
  'stock_movements',
  'purchases',
  'purchase_lines',
  'supplier_returns',
  'supplier_return_lines',
  'expenses',
  'cash_moves',
  'day_closes',
  'audit_log',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

/** The slice of a `tenants` row the query layer needs. */
export type TenantRef = { readonly id: string; readonly db_shard: string };

/** Bindings that may hold tenant rows. v1 has one (`DB`); shards come later (13 §4, T-111). */
const SHARDS = ['DB'] as const;

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

const TENANT_SET: ReadonlySet<string> = new Set(TENANT_TABLES);
const TABLE_REF = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi;
const TENANT_PREDICATE = /\b(?:[a-z_][a-z0-9_]*\.)?tenant_id\s*=\s*\?1\b/gi;
const TENANT_INSERT =
  /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[a-z_][a-z0-9_]*\s*\(\s*tenant_id\s*,[^)]*\)\s*(?:VALUES\s*\(\s*\?1\s*,|SELECT\s+\?1\s*,)/i;
const COLUMN = /^[a-z_][a-z0-9_]*$/;

export class TenantScopeError extends Error {
  readonly sql: string;

  constructor(message: string, sql: string) {
    super(`${message}: ${sql}`);
    this.name = 'TenantScopeError';
    this.sql = sql;
  }
}

/** Tenant tables a statement names after FROM / JOIN / INTO / UPDATE. */
export function tenantTablesIn(sql: string): string[] {
  const found: string[] = [];
  for (const m of sql.matchAll(TABLE_REF)) {
    const name = (m[1] ?? '').toLowerCase();
    if (TENANT_SET.has(name)) found.push(name);
  }
  return found;
}

/**
 * Throws unless every tenant-table reference in `sql` is scoped to `?1`:
 * one `tenant_id = ?1` per reference, where an INSERT's leading `(tenant_id, …) VALUES (?1, …)`
 * counts for its target table.
 */
export function assertTenantScoped(sql: string): void {
  const refs = tenantTablesIn(sql).length;
  if (refs === 0) return;
  let scoped = [...sql.matchAll(TENANT_PREDICATE)].length;
  if (/^\s*INSERT\b/i.test(sql)) {
    if (!TENANT_INSERT.test(sql)) {
      throw new TenantScopeError(
        'INSERT into a tenant table must start with (tenant_id, …) bound to ?1',
        sql,
      );
    }
    scoped += 1;
  }
  if (scoped < refs) {
    throw new TenantScopeError(
      `statement names ${refs} tenant table(s) but has ${scoped} tenant_id = ?1 predicate(s)`,
      sql,
    );
  }
}

function assertTable(table: string): asserts table is TenantTable {
  if (!TENANT_SET.has(table)) {
    throw new TenantScopeError('not a tenant table', table);
  }
}

function columnsOf(row: Row): string[] {
  // tenant_id is never taken from a row (13 §5 rule 3).
  const cols = Object.keys(row).filter((c) => c !== 'tenant_id');
  for (const c of cols) {
    if (!COLUMN.test(c)) throw new TenantScopeError('bad column name', c);
  }
  return cols;
}

/** INSERT for one row; `tenant_id` is `?1`, the row's own `tenant_id` key is dropped. */
export function insertSql(table: TenantTable, row: Row): [string, SqlValue[]] {
  assertTable(table);
  const cols = columnsOf(row);
  const sql = `INSERT INTO ${table} (tenant_id${cols.map((c) => `, ${c}`).join('')}) VALUES (?1${cols.map((_, i) => `, ?${i + 2}`).join('')})`;
  return [sql, cols.map((c) => row[c] ?? null)];
}

/** Upsert keyed by `(tenant_id, id)`: insert, or overwrite every given column. */
export function upsertSql(table: TenantTable, row: Row): [string, SqlValue[]] {
  const [insert, params] = insertSql(table, row);
  const cols = columnsOf(row).filter((c) => c !== 'id');
  const set = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  const sql =
    cols.length === 0
      ? `${insert} ON CONFLICT(tenant_id, id) DO NOTHING`
      : `${insert} ON CONFLICT(tenant_id, id) DO UPDATE SET ${set}`;
  return [sql, params];
}

export type TenantDb = {
  readonly tenantId: string;
  /** A prepared statement with `?1` = tenant id and `params` as `?2…`. */
  prepare(sql: string, ...params: SqlValue[]): D1PreparedStatement;
  select<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  first<T = Row>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  run(sql: string, ...params: SqlValue[]): Promise<D1Result>;
  insert(table: TenantTable, row: Row): D1PreparedStatement;
  upsert(table: TenantTable, row: Row): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
};

/** Resolves the tenant's shard binding (v1: always `DB`). */
export function shardOf(env: Env, tenant: TenantRef): D1Database {
  const name = tenant.db_shard;
  if (!(SHARDS as readonly string[]).includes(name)) {
    throw new Error(`unknown D1 shard '${name}' for tenant ${tenant.id}`);
  }
  return env[name as (typeof SHARDS)[number]];
}

export function tenantDb(env: Env, tenant: TenantRef): TenantDb {
  if (tenant.id.length === 0) throw new Error('tenant id is required');
  const db = shardOf(env, tenant);
  const prepare = (sql: string, ...params: SqlValue[]): D1PreparedStatement => {
    assertTenantScoped(sql);
    return db.prepare(sql).bind(tenant.id, ...params);
  };
  return {
    tenantId: tenant.id,
    prepare,
    async select<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]> {
      const { results } = await prepare(sql, ...params).all<T>();
      return results;
    },
    first<T = Row>(sql: string, ...params: SqlValue[]): Promise<T | null> {
      return prepare(sql, ...params).first<T>();
    },
    run(sql: string, ...params: SqlValue[]): Promise<D1Result> {
      return prepare(sql, ...params).run();
    },
    insert(table, row) {
      const [sql, params] = insertSql(table, row);
      return prepare(sql, ...params);
    },
    upsert(table, row) {
      const [sql, params] = upsertSql(table, row);
      return prepare(sql, ...params);
    },
    batch(statements) {
      return db.batch(statements);
    },
  };
}

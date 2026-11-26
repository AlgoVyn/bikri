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
  'change_log_watermarks',
  'expense_category_templates',
  'shop_requests',
  'operator_audit',
] as const;

/** Every tenant-scoped D1 table (02 §1.1: server-owned, master, ledger). */
export const TENANT_TABLES = [
  'change_log',
  'applied_ops',
  'sync_conflicts',
  'devices',
  'branch_device_codes',
  'enrolment_codes',
  'owner_email_codes',
  'shop',
  'branches',
  'staff',
  'categories',
  'products',
  'bundle_items',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'quotations',
  'quotation_lines',
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
// The optional `(` and whitespace catch `FROM(sales)` and `FROM (sales)`, which SQLite
// accepts and which a whitespace-only pattern silently missed.
const TABLE_REF =
  /\b(?:FROM|JOIN|INTO|UPDATE(?:\s+OR\s+\w+)?)\s*\(?\s*(?:(?:"?[a-z_][a-z0-9_]*"?)\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const TENANT_PREDICATE = /\b(?:[a-z_][a-z0-9_]*\.)?tenant_id\s*=\s*\?1\b/gi;
const TENANT_INSERT =
  /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[a-z_][a-z0-9_]*\s*\(\s*tenant_id\s*,[^)]*\)\s*(?:VALUES\s*\(\s*\?1\s*,|SELECT\s+\?1\s*,)/i;
/** `VALUES (…), (…)` only scopes the first row; a multi-row INSERT is never accepted. */
const MULTI_ROW_INSERT = /\bVALUES\s*\([^)]*\)\s*,\s*\(/i;
/** The table an INSERT targets, so it can be excluded from the unaliased-reference rule. */
const INSERT_TARGET =
  /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\(?\s*(?:(?:"?[a-z_][a-z0-9_]*"?)\.)?"?([a-z_][a-z0-9_]*)"?/i;
/** The part of a statement that lists tables after FROM, up to the next clause. */
const FROM_CLAUSE =
  /\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|\bRETURNING\b|$)/gi;
/**
 * A CTE or derived table can hide a tenant table behind a predicate on its alias
 * (`WITH x AS (SELECT * FROM sales) … WHERE x.tenant_id = ?1`), which the global
 * predicate count would accept. No tenant statement needs either construct, so refuse
 * them when a tenant table is named (13 §5).
 */
const CTE = /\bWITH\s+(?:RECURSIVE\s+)?[a-z_][a-z0-9_]*\s+AS\b/i;
const DERIVED_TABLE = /\b(?:FROM|JOIN)\s*\(\s*(?:SELECT|WITH)\b/i;
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

/** Tenant tables named after a comma inside a FROM clause (`FROM a, b`). */
export function commaJoinedTables(sql: string): string[] {
  const found: string[] = [];
  for (const m of sql.matchAll(FROM_CLAUSE)) {
    const clause = m[1] ?? '';
    for (const part of clause.split(',').slice(1)) {
      const name =
        /^\s*(?:(?:"?[a-z_][a-z0-9_]*"?)\.)?"?([a-z_][a-z0-9_]*)"?/i
          .exec(part)?.[1]
          ?.toLowerCase() ?? '';
      if (TENANT_SET.has(name)) found.push(name);
    }
  }
  return found;
}

/** A table reference with an optional `AS`/bare alias, after FROM, JOIN or a comma. */
const ALIAS_REF =
  /(?:,|\bFROM|\bJOIN)\s+(?:(?:"?\w+"?)\.)?"?(\w+)"?(?:\s+(?:AS\s+)?("?\w+"?))?/giu;

/**
 * Throws unless every tenant-table reference in `sql` is scoped to `?1`:
 * one `tenant_id = ?1` per reference, where an INSERT's leading `(tenant_id, …) VALUES (?1, …)`
 * counts for its target table.
 */
const SCOPE_CACHE = new Set<string>();
export const SCOPE_CACHE_MAX = 1_000;
/* Aliases that are SQL keywords, not table aliases, when scanning `FROM tbl x`. */
const ALIAS_KEYWORDS: ReadonlySet<string> = new Set([
  'on',
  'where',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'natural',
  'group',
  'order',
  'limit',
  'using',
  'set',
  'values',
  'select',
  'from',
  'as',
  'and',
  'or',
  'not',
  'in',
  'is',
  'null',
  'case',
  'when',
  'then',
  'else',
  'end',
  'desc',
  'asc',
  'by',
]);

/**
 * Refs and aliases per statement scope (`SELECT` starts a new scope, so a subquery's own
 * `tenant_id = ?1` predicate covers its own tables). A comma is a table separator too, so
 * an aliased comma join is checked like an explicit `JOIN` (API-L7).
 */
function scopeRefs(sql: string): Array<{ refs: number; aliased: number }> {
  return sql.split(/\bSELECT\b/iu).map((part) => {
    const refs = tenantTablesIn(part).length + commaJoinedTables(part).length;
    let aliased = 0;
    for (const match of part.matchAll(ALIAS_REF)) {
      const table = (match[1] ?? '').toLowerCase();
      const alias = (match[2] ?? '').replace(/"/gu, '').toLowerCase();
      if (!TENANT_SET.has(table) || !alias || ALIAS_KEYWORDS.has(alias))
        continue;
      aliased += 1;
    }
    return { refs, aliased };
  });
}

export function assertTenantScoped(sql: string): void {
  if (SCOPE_CACHE.has(sql)) return;
  const named = tenantTablesIn(sql);
  const comma = commaJoinedTables(sql);
  const refs = named.length + comma.length;
  if (refs === 0) {
    rememberScoped(sql);
    return;
  }
  if (CTE.test(sql) || DERIVED_TABLE.test(sql)) {
    throw new TenantScopeError(
      'tenant SQL must not use CTEs or derived tables',
      sql,
    );
  }
  let scoped = [...sql.matchAll(TENANT_PREDICATE)].length;
  if (/^\s*INSERT\b/i.test(sql)) {
    if (!TENANT_INSERT.test(sql)) {
      throw new TenantScopeError(
        'INSERT into a tenant table must start with (tenant_id, …) bound to ?1',
        sql,
      );
    }
    if (MULTI_ROW_INSERT.test(sql)) {
      throw new TenantScopeError(
        'INSERT into a tenant table must have exactly one row bound to ?1',
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
  // Counting predicates alone lets a duplicate predicate on one table mask an
  // unscoped joined table. Every alias that names a tenant table must carry its own
  // `alias.tenant_id = ?1`; a table without an alias is covered by the count above.
  const aliases = new Map<string, string>();
  for (const match of sql.matchAll(ALIAS_REF)) {
    const table = (match[1] ?? '').toLowerCase();
    const alias = (match[2] ?? '').replace(/"/gu, '').toLowerCase();
    if (!TENANT_SET.has(table)) continue;
    if (!alias || ALIAS_KEYWORDS.has(alias)) continue;
    if (alias !== table) aliases.set(alias, table);
  }
  for (const alias of aliases.keys()) {
    if (!new RegExp(`\\b${alias}\\.tenant_id\\s*=\\s*\\?1`, 'iu').test(sql))
      throw new TenantScopeError(
        `joined table alias ${alias} has no tenant_id = ?1 predicate`,
        sql,
      );
  }
  // Two unaliased tenant tables in one statement cannot be told apart by two bare
  // `tenant_id = ?1` predicates, so the second one could be unscoped (API-L7). Scopes are
  // per `SELECT`: a subquery's predicate only covers its own tables.
  const target = (INSERT_TARGET.exec(sql)?.[1] ?? '').toLowerCase();
  const insertTarget = TENANT_SET.has(target) ? target : null;
  let insertTargetSeen = false;
  for (const scope of scopeRefs(sql)) {
    const targetHere = !insertTargetSeen && insertTarget !== null ? 1 : 0;
    insertTargetSeen = true;
    if (scope.refs - scope.aliased - targetHere > 1) {
      throw new TenantScopeError(
        'a statement with several tenant tables must alias every one of them',
        sql,
      );
    }
  }
  rememberScoped(sql);
}

/** Test hook: how many statements the scope cache holds (bounded FIFO, API-L7). */
export function scopeCacheSize(): number {
  return SCOPE_CACHE.size;
}

/** Test hook: start from an empty scope cache. */
export function resetScopeCache(): void {
  SCOPE_CACHE.clear();
}

/** Caches only successful checks; a bad statement must throw every time it is used. */
function rememberScoped(sql: string): void {
  if (SCOPE_CACHE.size >= SCOPE_CACHE_MAX) {
    // FIFO: Set iteration follows insertion order. Evict one entry per new statement
    // instead of clearing 1,000 verified statements on the 1,001st.
    const oldest = SCOPE_CACHE.values().next().value;
    if (oldest !== undefined) SCOPE_CACHE.delete(oldest);
  }
  SCOPE_CACHE.add(sql);
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

/**
 * INSERT that is skipped when `op_id` is already in `applied_ops`. Server-authored
 * side effects (stock movements, audit rows, conflict rows) use this so a retried
 * push that races the first request cannot write them twice.
 */
export function insertIfNotAppliedSql(
  table: TenantTable,
  row: Row,
  opId: string,
): [string, SqlValue[]] {
  assertTable(table);
  const cols = columnsOf(row);
  const placeholders = cols.map((_, i) => `?${i + 2}`);
  const sql = `INSERT INTO ${table} (tenant_id${cols.map((c) => `, ${c}`).join('')}) SELECT ?1${placeholders.map((p) => `, ${p}`).join('')} WHERE NOT EXISTS (SELECT 1 FROM applied_ops WHERE tenant_id = ?1 AND op_id = ?${cols.length + 2})`;
  return [sql, [...cols.map((c) => row[c] ?? null), opId]];
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
  /** Insert, but never overwrite an existing row (append-only imports). */
  insertOnly(table: TenantTable, row: Row): D1PreparedStatement;
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
    insertOnly(table, row) {
      const [sql, params] = insertSql(table, row);
      return prepare(`${sql} ON CONFLICT(tenant_id, id) DO NOTHING`, ...params);
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

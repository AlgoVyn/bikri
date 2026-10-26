import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertTenantScoped,
  insertSql,
  shardOf,
  TenantScopeError,
  tenantDb,
  upsertSql,
} from '../../src/db/tenantDb.ts';

const T = 1_793_050_000_000;
const A = { id: 'tenant-a', db_shard: 'DB' };
const B = { id: 'tenant-b', db_shard: 'DB' };

describe('assertTenantScoped', () => {
  it.each([
    'SELECT * FROM products WHERE tenant_id = ?1 AND id = ?2',
    'SELECT p.id FROM products p JOIN product_barcodes b ON b.tenant_id = ?1 AND b.product_id = p.id WHERE p.tenant_id = ?1',
    'UPDATE products SET price = ?2 WHERE tenant_id = ?1 AND id = ?3',
    'DELETE FROM change_log WHERE tenant_id = ?1 AND seq < ?2',
    'INSERT INTO products (tenant_id, id) VALUES (?1, ?2)',
    'INSERT INTO change_log (tenant_id, tbl) SELECT ?1, tbl FROM sales WHERE tenant_id = ?1',
    'SELECT * FROM tenants WHERE id = ?1',
    'SELECT value FROM meta',
  ])('accepts %s', (sql) => {
    expect(() => assertTenantScoped(sql)).not.toThrow();
  });

  it.each([
    'SELECT * FROM products WHERE id = ?1',
    'SELECT * FROM products WHERE tenant_id = ?2',
    'SELECT * FROM products p JOIN product_barcodes b ON b.product_id = p.id WHERE p.tenant_id = ?1',
    'UPDATE sales SET status = ?2 WHERE id = ?3',
    'DELETE FROM products',
    'INSERT INTO products (id, tenant_id) VALUES (?2, ?1)',
    'INSERT INTO products (tenant_id, id) VALUES (?2, ?1)',
  ])('refuses %s', (sql) => {
    expect(() => assertTenantScoped(sql)).toThrow(TenantScopeError);
  });
});

describe('statement builders', () => {
  it('builds INSERT with tenant_id first and drops a tenant_id from the row', () => {
    const [sql, params] = insertSql('categories', {
      tenant_id: 'evil',
      id: 'c1',
      name_en: 'Phones',
    });
    expect(sql).toBe(
      'INSERT INTO categories (tenant_id, id, name_en) VALUES (?1, ?2, ?3)',
    );
    expect(params).toEqual(['c1', 'Phones']);
    assertTenantScoped(sql);
  });

  it('builds an upsert keyed by (tenant_id, id)', () => {
    const [sql] = upsertSql('categories', { id: 'c1', name_en: 'Phones' });
    expect(sql).toMatch(
      /ON CONFLICT\(tenant_id, id\) DO UPDATE SET name_en = excluded\.name_en$/,
    );
    assertTenantScoped(sql);
  });

  it('refuses platform tables and bad column names', () => {
    expect(() => insertSql('tenants' as never, { id: 'x' })).toThrow(
      TenantScopeError,
    );
    expect(() =>
      insertSql('categories', { 'id) VALUES (1); --': 'x' }),
    ).toThrow(TenantScopeError);
  });

  it('resolves only known shards', () => {
    expect(shardOf(env, A)).toBe(env.DB);
    expect(() => shardOf(env, { id: 'x', db_shard: 'DB2' })).toThrow(
      /unknown D1 shard/,
    );
  });
});

describe('tenantDb against D1', () => {
  beforeAll(async () => {
    const tenant = (id: string, slug: string) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO tenants (id, slug, display_name, restore_epoch, created_by_email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
      ).bind(id, slug, slug, String(T), 'operator@example.com', T);
    await env.DB.batch([tenant(A.id, 'shop-a'), tenant(B.id, 'shop-b')]);
  });

  it('writes and reads only its own tenant with colliding ids', async () => {
    const a = tenantDb(env, A);
    const b = tenantDb(env, B);
    const row = { id: 'cat1', name_en: 'Phones', created_at: T, updated_at: T };
    await a.batch([a.upsert('categories', row)]);
    await b.batch([b.upsert('categories', { ...row, name_en: 'Cables' })]);
    await b.run(
      'UPDATE categories SET name_en = ?2 WHERE tenant_id = ?1 AND id = ?3',
      'Chargers',
      'cat1',
    );
    expect(
      await a.select<{ name_en: string }>(
        'SELECT name_en FROM categories WHERE tenant_id = ?1',
      ),
    ).toEqual([{ name_en: 'Phones' }]);
    expect(
      await b.first<{ name_en: string }>(
        'SELECT name_en FROM categories WHERE tenant_id = ?1 AND id = ?2',
        'cat1',
      ),
    ).toEqual({ name_en: 'Chargers' });
  });

  it('refuses an unscoped statement before it reaches D1', () => {
    const a = tenantDb(env, A);
    expect(() => a.prepare('SELECT * FROM categories')).toThrow(
      TenantScopeError,
    );
    expect(() => tenantDb(env, { id: '', db_shard: 'DB' })).toThrow();
  });
});

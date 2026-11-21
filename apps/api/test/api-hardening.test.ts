/**
 * Regression tests for the 2026-11-21 API review (02-api-security-tenancy.md):
 * API-H1–H7, API-M1–M6 and API-L1–L9, plus CORE-M1 in the device-move route.
 */
import { env } from 'cloudflare:workers';
import { businessDate, newId, nextAvgCost } from '@bikri/core';
import { describe, expect, it, vi } from 'vitest';
import { resetJwksCache, verifyAccessJwt } from '../src/auth/access.ts';
import { base64url } from '../src/auth/crypto.ts';
import { tenantDb } from '../src/db/tenantDb.ts';
import { statusForError } from '../src/middleware/onError.ts';
import { gcTenantFiles } from '../src/platform/filesGc.ts';
import { pruneAll } from '../src/platform/prune.ts';
import {
  addRequestEmail,
  createShopRequest,
} from '../src/platform/shopRequests.ts';
import { listBackupObjects } from '../src/routes/admin.ts';
import { applyOps, CallBudget } from '../src/sync/applyOps.ts';
import { allocateDeviceCode } from '../src/sync/devices.ts';
import type { DeviceRow, TenantRow } from '../src/types.ts';
import {
  addBundleFixture,
  addSupportDevice,
  api,
  IDS,
  json,
  type Shop,
  seedShop,
  setStatus,
} from './helpers/fixtures.ts';
import {
  bundleSaleOps,
  op,
  productRow,
  push,
  pushOk,
  saleOps,
} from './helpers/ops.ts';

const DAY = 86_400_000;
const count = async (sql: string, ...params: unknown[]) =>
  Number(
    (
      await env.DB.prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

const tenantRow = async (id: string): Promise<TenantRow> => {
  const row = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?1')
    .bind(id)
    .first<TenantRow>();
  if (!row) throw new Error('tenant missing');
  return row;
};

const deviceRow = async (
  tenantId: string,
  deviceId: string,
): Promise<DeviceRow> => {
  const row = await env.DB.prepare(
    'SELECT * FROM devices WHERE tenant_id = ?1 AND id = ?2',
  )
    .bind(tenantId, deviceId)
    .first<DeviceRow>();
  if (!row) throw new Error('device missing');
  return row;
};

const addStaff = async (
  shop: Shop,
  role: 'manager' | 'cashier' | 'owner',
  permissions: Record<string, boolean> = {},
) => {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO staff (tenant_id, id, name, role, permissions_json, pin_hash, pin_salt, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(
      shop.tenantId,
      id,
      role,
      role,
      JSON.stringify(permissions),
      'a'.repeat(44),
      'a'.repeat(24),
      Date.now(),
    )
    .run();
  return id;
};

/** A void (and its reversal payment) for a stored sale, dated today. */
const voidOps = (
  shop: Shop,
  saleId: string,
  staffId: string,
  extra: { approvedBy?: string; amount?: number } = {},
) => {
  const tx = newId();
  const voidId = newId();
  const now = Date.now();
  const date = businessDate(now, 'Asia/Karachi');
  const amount = extra.amount ?? 150000;
  const ops = [
    op(
      'sale_voids',
      'insert',
      {
        id: voidId,
        sale_id: saleId,
        reason: 'Wrong item',
        replacement_sale_id: null,
        device_id: shop.till.id,
        staff_id: staffId,
        business_date: date,
        created_at: now,
      },
      { tx_id: tx },
    ),
    op(
      'payments',
      'insert',
      {
        id: newId(),
        direction: 'out',
        method: 'cash',
        purpose: 'void',
        amount,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: saleId,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: null,
        party_id: null,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: staffId,
        business_date: date,
        created_at: now,
      },
      { tx_id: tx },
    ),
  ];
  if (extra.approvedBy !== undefined)
    ops.push(
      op(
        'audit_log',
        'insert',
        {
          id: newId(),
          action: 'override',
          entity: 'sale_voids',
          entity_id: voidId,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'sale.void',
            approved_by: extra.approvedBy,
          }),
          device_id: shop.till.id,
          staff_id: staffId,
          created_at: now,
        },
        { tx_id: tx },
      ),
    );
  return ops;
};

/** A sale rung `daysAgo` business days ago, pushed by the owner. */

describe('API-H1: a lost guard rolls back the whole transaction', () => {
  it('rolls back a master edit and its sibling sale together, then replays them', async () => {
    const shop = await seedShop('H1 partial');
    const tenant = await tenantRow(shop.tenantId);
    const device = await deviceRow(shop.tenantId, shop.till.id);
    const tx = newId();
    const edit = op(
      'products',
      'upsert',
      productRow(IDS.product, { price: 160000, updated_by: IDS.owner }),
      { tx_id: tx, base_rev: 3, changed_fields: ['price'] },
    );
    const sale = saleOps(shop, shop.till, 1);
    for (const entry of sale) entry.tx_id = tx;
    const base = tenantDb(env, tenant);
    let calls = 0;
    let raced = false;
    // Commit a concurrent rev bump just before the write batch, so the guarded UPDATE
    // misses. The old code committed the sale and lost only the product edit.
    const racing = {
      ...base,
      batch: async (statements: D1PreparedStatement[]) => {
        calls += 1;
        if (calls === 3 && !raced) {
          raced = true;
          await base.run(
            'UPDATE products SET rev = rev + 1 WHERE tenant_id = ?1 AND id = ?2',
            IDS.product,
          );
        }
        return base.batch(statements);
      },
    } as typeof base;
    const outcome = await applyOps(
      { db: racing, tenant, device, now: Date.now(), budget: new CallBudget() },
      [...sale, edit],
    );
    expect(raced).toBe(true);
    expect(outcome.results).toHaveLength(4);
    // The replayed master edit merges with the concurrently bumped row; the sale applies.
    expect(outcome.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'applied',
      'conflict_merged',
    ]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1 AND id = ?2',
        shop.tenantId,
        String(sale[0]?.row?.id),
      ),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        'SELECT price FROM products WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, IDS.product)
        .first<{ price: number }>(),
    ).toEqual({ price: 160000 });
  });

  it('keeps one active owner when a demotion and a promotion race a rev bump', async () => {
    const shop = await seedShop('H1 owners');
    const second = await addStaff(shop, 'manager');
    const tenant = await tenantRow(shop.tenantId);
    const device = await deviceRow(shop.tenantId, shop.till.id);
    const tx = newId();
    const row = {
      permissions_json: '{}',
      max_discount_bp: 500,
      deleted_at: null,
      created_at: 1,
      updated_at: Date.now(),
      updated_by: IDS.owner,
    };
    const demote = op(
      'staff',
      'upsert',
      { ...row, id: IDS.owner, role: 'owner', active: 0 },
      { tx_id: tx, base_rev: 1, changed_fields: ['active'] },
    );
    const promote = op(
      'staff',
      'upsert',
      { ...row, id: second, name: 'Manager', role: 'owner', active: 1 },
      { tx_id: tx, base_rev: 1, changed_fields: ['role', 'active'] },
    );
    const base = tenantDb(env, tenant);
    let calls = 0;
    let raced = false;
    const racing = {
      ...base,
      batch: async (statements: D1PreparedStatement[]) => {
        calls += 1;
        if (calls === 3 && !raced) {
          raced = true;
          // Another till edits the future owner, so only the promotion's guard misses.
          await base.run(
            'UPDATE staff SET rev = rev + 1 WHERE tenant_id = ?1 AND id = ?2',
            second,
          );
        }
        return base.batch(statements);
      },
    } as typeof base;
    const outcome = await applyOps(
      { db: racing, tenant, device, now: Date.now(), budget: new CallBudget() },
      [demote, promote],
    );
    expect(raced).toBe(true);
    expect(outcome.results.map((r) => r.result)).toEqual([
      'applied',
      'conflict_merged',
    ]);
    const owners = await env.DB.prepare(
      "SELECT id FROM staff WHERE tenant_id = ?1 AND role = 'owner' AND active = 1 AND deleted_at IS NULL",
    )
      .bind(shop.tenantId)
      .all<{ id: string }>();
    expect(owners.results.map((row) => row.id)).toEqual([second]);
  });

  it('applies a retried last_cost-only upsert whose cost is already stored', async () => {
    const shop = await seedShop('H1 cost retry');
    await env.DB.prepare(
      'UPDATE products SET last_cost = 7000, avg_cost = 7000 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    const res = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(IDS.product, { last_cost: 7000, updated_by: IDS.cashier }),
        { base_rev: 3, changed_fields: ['last_cost'] },
      ),
    ]);
    expect(res.results[0]?.error_code ?? null).toBeNull();
  });
});

describe('API-H2: only an owner voids a past-day bill', () => {
  it('refuses manager self-approval, cashier overrides and grant-only cashiers', async () => {
    const shop = await seedShop('H2 voids');
    const manager = await addStaff(shop, 'manager');
    const granted = await addStaff(shop, 'cashier', { 'sale.void': true });
    const old = saleOps(shop, shop.till, 903, { now: Date.now() - 3 * DAY });
    await pushOk(shop.till, old);
    const oldSale = String(old[0]?.row?.id);

    const selfApproved = await pushOk(
      shop.till,
      voidOps(shop, oldSale, manager, { approvedBy: manager }),
    );
    expect(selfApproved.results[0]).toMatchObject({
      result: 'rejected',
      error_code: 'FORBIDDEN',
    });

    const cashierManager = await pushOk(
      shop.till,
      voidOps(shop, oldSale, IDS.cashier, { approvedBy: manager }),
    );
    expect(cashierManager.results[0]?.error_code).toBe('FORBIDDEN');

    const grantOnly = await pushOk(shop.till, voidOps(shop, oldSale, granted));
    expect(grantOnly.results[0]?.error_code).toBe('FORBIDDEN');

    // A manager may still void a same-day bill without any override.
    const sameDay = saleOps(shop, shop.till, 1);
    await pushOk(shop.till, sameDay);
    const sameDayVoid = await pushOk(
      shop.till,
      voidOps(shop, String(sameDay[0]?.row?.id), manager),
    );
    expect(sameDayVoid.results[0]?.error_code ?? null).toBeNull();

    // An owner approval voids the old bill.
    const approved = await pushOk(
      shop.till,
      voidOps(shop, oldSale, manager, { approvedBy: IDS.owner }),
    );
    expect(approved.results[0]?.error_code ?? null).toBeNull();
  });
});

describe('API-H3: effectiveStaff follows changed_fields', () => {
  it('rejects a transaction that would leave zero owners through an unlisted role', async () => {
    const shop = await seedShop('H3 owners');
    const manager = await addStaff(shop, 'manager');
    const tx = newId();
    const base = {
      permissions_json: '{}',
      max_discount_bp: 500,
      deleted_at: null,
      created_at: 1,
      updated_at: Date.now(),
      updated_by: IDS.owner,
    };
    const demote = op(
      'staff',
      'upsert',
      { ...base, id: IDS.owner, role: 'owner', active: 0 },
      { tx_id: tx, base_rev: 1, changed_fields: ['active'] },
    );
    // The full row claims `role: 'owner'`, but `changed_fields` only writes the name.
    const rename = op(
      'staff',
      'upsert',
      {
        ...base,
        id: manager,
        name: 'Manager renamed',
        role: 'owner',
        active: 1,
      },
      { tx_id: tx, base_rev: 1, changed_fields: ['name'] },
    );
    const res = await pushOk(shop.till, [demote, rename]);
    expect(res.results.map((row) => row.error_code)).toEqual([
      'CONSTRAINT_FAILED',
      'CONSTRAINT_FAILED',
    ]);
    const owner = await env.DB.prepare(
      'SELECT active, role FROM staff WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.owner)
      .first<{ active: number; role: string }>();
    expect(owner).toEqual({ active: 1, role: 'owner' });
  });
});

describe('API-H4: ending support revokes access at once', () => {
  it('refuses a support token once support_until has passed, even before expires_at', async () => {
    const shop = await seedShop('H4 support');
    const support = await addSupportDevice(shop, Date.now() + 3_600_000);
    expect((await api('/me', { token: support.token })).status).toBe(200);
    await env.DB.prepare('UPDATE tenants SET support_until = ?2 WHERE id = ?1')
      .bind(shop.tenantId, Date.now() - 1)
      .run();
    const gone = await api('/me', { token: support.token });
    expect(gone.status).toBe(401);
    expect((await json<{ error: { code: string } }>(gone)).error.code).toBe(
      'DEVICE_REVOKED',
    );
  });

  it('revokes every live support device inside the end-support batch', async () => {
    const shop = await seedShop('H4 end');
    const a = await addSupportDevice(shop, Date.now() + 86_400_000);
    const b = await addSupportDevice(shop, Date.now() + 86_400_000);
    await env.DB.prepare(
      'UPDATE tenants SET support_until = ?2, support_reason = ?3 WHERE id = ?1',
    )
      .bind(shop.tenantId, Date.now() + 86_400_000, 'test')
      .run();
    expect(
      (
        await api('/shop/support-access/end', {
          method: 'POST',
          token: shop.admin.token,
          headers: { 'x-bikri-staff': IDS.owner },
        })
      ).status,
    ).toBe(200);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND kind = 'support' AND revoked_at IS NULL",
        shop.tenantId,
      ),
    ).toBe(0);
    for (const device of [a, b])
      expect((await api('/me', { token: device.token })).status).toBe(401);
  });
});

describe('API-H5: only applied sales advance last_invoice_seq', () => {
  it('does not poison the device with a rejected bill', async () => {
    const shop = await seedShop('H5 invoice');
    const bad = saleOps(shop, shop.till, 9);
    const line = bad[1]?.row;
    if (line) line.qty_milli = 0;
    const rejected = await pushOk(shop.till, bad);
    expect(rejected.results[0]?.result).toBe('rejected');
    expect(
      await env.DB.prepare(
        'SELECT last_invoice_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.till.id)
        .first<{ last_invoice_seq: number }>(),
    ).toEqual({ last_invoice_seq: 0 });
    const ok = await pushOk(shop.till, saleOps(shop, shop.till, 3));
    expect(ok.results[0]?.result).toBe('applied');
    expect(
      await env.DB.prepare(
        'SELECT last_invoice_seq FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.till.id)
        .first<{ last_invoice_seq: number }>(),
    ).toEqual({ last_invoice_seq: 3 });
  });
});

describe('API-H6: bundle invariants use the effective row', () => {
  it('refuses a kind flip on an active bundle with a recipe', async () => {
    const shop = await seedShop('H6 flip');
    const bundle = await addBundleFixture(shop);
    const res = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(bundle.bundleId, { sku: 'BND-0001', kind: 'simple' }),
        { base_rev: 1, changed_fields: ['kind'] },
      ),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('refuses track_stock on a bundle and a kind flip that keeps track_stock', async () => {
    const shop = await seedShop('H6 track');
    const bundle = await addBundleFixture(shop);
    const stock = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(bundle.bundleId, {
          sku: 'BND-0001',
          kind: 'bundle',
          track_stock: 1,
        }),
        { base_rev: 1, changed_fields: ['track_stock'] },
      ),
    ]);
    expect(stock.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    // A simple product with track_stock 1 flipped to a bundle without writing it.
    const simple = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(IDS.component4, { sku: 'CMP-0004', kind: 'bundle' }),
        { base_rev: 1, changed_fields: ['kind'] },
      ),
    ]);
    expect(simple.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('accepts a 20-for-20 recipe swap and keeps counting the active recipe', async () => {
    const shop = await seedShop('H6 recipe');
    const now = Date.now();
    const bundleId = newId(now);
    const itemIds = Array.from({ length: 20 }, () => newId(now));
    const componentIds = Array.from({ length: 21 }, () => newId(now));
    const item = (index: number) => String(itemIds[index]);
    const component = (index: number) => String(componentIds[index]);
    const statements = [
      env.DB.prepare(
        `INSERT INTO products (tenant_id, id, name_en, sku, price, kind, track_stock, created_at, updated_at, rev)
         VALUES (?1, ?2, 'Swap bundle', 'SWP-1', 200000, 'bundle', 0, ?3, ?3, 1)`,
      ).bind(shop.tenantId, bundleId, now),
    ];
    for (let index = 0; index < 21; index += 1)
      statements.push(
        env.DB.prepare(
          `INSERT INTO products (tenant_id, id, name_en, sku, price, created_at, updated_at, rev)
           VALUES (?1, ?2, ?3, ?4, 1000, ?5, ?5, 1)`,
        ).bind(
          shop.tenantId,
          component(index),
          `Component ${index}`,
          `SWC-${index}`,
          now,
        ),
      );
    for (let index = 0; index < 20; index += 1)
      statements.push(
        env.DB.prepare(
          `INSERT INTO bundle_items (tenant_id, id, bundle_id, component_product_id, qty_milli, sort_order, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 1000, ?5, ?6, ?6)`,
        ).bind(
          shop.tenantId,
          item(index),
          bundleId,
          component(index),
          index,
          now,
        ),
      );
    await env.DB.batch(statements);

    const tx = newId();
    const swapped = await pushOk(shop.till, [
      op(
        'bundle_items',
        'delete',
        { id: item(0) },
        { tx_id: tx, base_rev: 1, updated_by: IDS.owner },
      ),
      op(
        'bundle_items',
        'upsert',
        {
          id: newId(),
          bundle_id: bundleId,
          component_product_id: component(20),
          qty_milli: 1000,
          sort_order: 20,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          updated_by: IDS.owner,
        },
        { tx_id: tx, base_rev: 0, changed_fields: [] },
      ),
    ]);
    expect(swapped.results.map((row) => row.error_code ?? null)).toEqual([
      null,
      null,
    ]);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM bundle_items WHERE tenant_id = ?1 AND bundle_id = ?2 AND deleted_at IS NULL',
        shop.tenantId,
        bundleId,
      ),
    ).toBe(20);
  });

  it('refuses soft-deleting the last component of a bundle', async () => {
    const shop = await seedShop('H6 last');
    const now = Date.now();
    const bundleId = newId(now);
    const itemId = newId(now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO products (tenant_id, id, name_en, sku, price, kind, track_stock, created_at, updated_at, rev)
         VALUES (?1, ?2, 'Last bundle', 'LST-1', 1000, 'bundle', 0, ?3, ?3, 1)`,
      ).bind(shop.tenantId, bundleId, now),
      env.DB.prepare(
        `INSERT INTO bundle_items (tenant_id, id, bundle_id, component_product_id, qty_milli, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1000, 0, ?5, ?5)`,
      ).bind(shop.tenantId, itemId, bundleId, IDS.product, now),
    ]);
    const res = await pushOk(shop.till, [
      op(
        'bundle_items',
        'upsert',
        {
          id: itemId,
          bundle_id: bundleId,
          component_product_id: IDS.product,
          qty_milli: 1000,
          sort_order: 0,
          created_at: now,
          updated_at: now,
          deleted_at: now,
          updated_by: IDS.owner,
        },
        { base_rev: 1, changed_fields: ['deleted_at'] },
      ),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });
});

describe('API-H7: change_log watermarks', () => {
  it('records a zero watermark once instead of rescanning every night', async () => {
    const shop = await seedShop('H7 zero');
    const now = Date.now();
    // The shop predates the cutoff but has no log rows at all.
    await env.DB.prepare('UPDATE tenants SET created_at = ?2 WHERE id = ?1')
      .bind(shop.tenantId, now - 60 * DAY)
      .run();
    const cutoffDay = new Date(now - 30 * DAY).toISOString().slice(0, 10);
    await pruneAll(env, now);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log_watermarks WHERE tenant_id = ?1 AND day = ?2 AND max_seq = 0',
        shop.tenantId,
        cutoffDay,
      ),
    ).toBe(1);
    await pruneAll(env, now);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log_watermarks WHERE tenant_id = ?1 AND day = ?2',
        shop.tenantId,
        cutoffDay,
      ),
    ).toBe(1);
  });

  it('does not scan a shop younger than the cutoff and skips deleting shops', async () => {
    const shop = await seedShop('H7 young');
    const deleting = await seedShop('H7 deleting');
    const now = Date.now();
    await env.DB.prepare('UPDATE change_log SET at = ?2 WHERE tenant_id = ?1')
      .bind(shop.tenantId, now - 40 * DAY)
      .run();
    await setStatus(deleting.tenantId, 'deleting');
    await pruneAll(env, now);
    const cutoffDay = new Date(now - 30 * DAY).toISOString().slice(0, 10);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log_watermarks WHERE tenant_id = ?1 AND day = ?2',
        shop.tenantId,
        cutoffDay,
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log_watermarks WHERE tenant_id = ?1',
        deleting.tenantId,
      ),
    ).toBe(0);
  });

  it('prunes superseded watermarks and deletes them with the tenant', async () => {
    const shop = await seedShop('H7 purge');
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO change_log_watermarks (tenant_id, day, max_seq) VALUES (?1, '2000-01-01', 5)",
    )
      .bind(shop.tenantId)
      .run();
    await pruneAll(env, now);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log_watermarks WHERE tenant_id = ?1 AND day = ?2',
        shop.tenantId,
        '2000-01-01',
      ),
    ).toBe(0);
    await env.DB.prepare(
      "INSERT INTO change_log_watermarks (tenant_id, day, max_seq) VALUES (?1, '2000-01-02', 5)",
    )
      .bind(shop.tenantId)
      .run();
    await setStatus(shop.tenantId, 'deleting');
    for (let i = 0; i < 5; i += 1) await pruneAll(env, Date.now());
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM change_log_watermarks WHERE tenant_id = ?1',
        shop.tenantId,
      ),
    ).toBe(0);
  });
});

describe('API-M1: offline sales and same-day cashier reversals', () => {
  it('accepts a sale made before the device could pull a shop, product or staff change', async () => {
    const shop = await seedShop('M1 offline');
    const now = Date.now();
    const seen = now - 3 * 3_600_000;
    const changedAt = now - 2 * 3_600_000;
    const rungAt = now - 3_600_000;
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, seen, shop.till.id)
      .run();
    await env.DB.prepare(
      'UPDATE shop SET tax_rate_bp = 1700, updated_at = ?2 WHERE tenant_id = ?1',
    )
      .bind(shop.tenantId, changedAt)
      .run();
    await env.DB.prepare(
      'UPDATE products SET price = 200000, updated_at = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product, changedAt)
      .run();
    await env.DB.prepare(
      'UPDATE staff SET max_discount_bp = 0, updated_at = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.cashier, changedAt)
      .run();
    // A 10% line discount that the new max_discount_bp would forbid.
    const ops = saleOps(shop, shop.till, 1, { now: rungAt });
    const line = ops[1]?.row;
    if (line) {
      const gross = Number(line.gross);
      const discount = Math.floor(gross / 10);
      Object.assign(line, {
        discount_type: 'pct',
        discount_value: 1000,
        discount,
        net: gross - discount,
      });
      const sale = ops[0]?.row;
      if (sale) {
        Object.assign(sale, {
          item_discount_total: discount,
          subtotal: gross - discount,
          gross_total: gross,
          total: gross - discount,
          paid_total: gross - discount,
          cash_tendered: gross - discount,
        });
      }
      const payment = ops[2]?.row;
      if (payment)
        Object.assign(payment, {
          amount: gross - discount,
          cash_tendered: gross - discount,
        });
    }
    const res = await pushOk(shop.till, ops);
    expect(res.results.map((row) => row.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('accepts a cashier reversal made the same day but synced the next morning', async () => {
    const shop = await seedShop('M1 reversal');
    const now = Date.now();
    const yesterday = now - DAY;
    const date = businessDate(yesterday);
    const original = {
      id: newId(yesterday),
      category_id: 'tea_snacks',
      amount: 5000,
      method: 'cash',
      payee: 'Tea',
      note: '',
      reverses_id: null,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: date,
      created_at: yesterday,
    };
    expect(
      (await pushOk(shop.till, [op('expenses', 'insert', original)])).results[0]
        ?.error_code ?? null,
    ).toBeNull();
    const reversal = {
      ...original,
      id: newId(),
      reverses_id: original.id,
      created_at: yesterday + 3_600_000,
    };
    const late = await pushOk(shop.till, [op('expenses', 'insert', reversal)]);
    expect(late.results[0]?.error_code ?? null).toBeNull();
    // The same expense cannot be reversed twice.
    const duplicate = await pushOk(shop.till, [
      op('expenses', 'insert', { ...reversal, id: newId() }),
    ]);
    expect(duplicate.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });

  it('refuses a cashier reversal of an earlier day', async () => {
    const shop = await seedShop('M1 reversal day');
    const now = Date.now();
    const twoDays = now - 2 * DAY;
    const date = businessDate(twoDays);
    const original = {
      id: newId(twoDays),
      category_id: 'tea_snacks',
      amount: 5000,
      method: 'cash',
      payee: 'Tea',
      note: '',
      reverses_id: null,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: date,
      created_at: twoDays,
    };
    await pushOk(shop.till, [op('expenses', 'insert', original)]);
    // The reversal keeps the original's business date (the client rule) but was made
    // today, so a cashier may not post it.
    const res = await pushOk(shop.till, [
      op('expenses', 'insert', {
        ...original,
        id: newId(),
        reverses_id: original.id,
        created_at: now,
      }),
    ]);
    expect(res.results[0]?.error_code).toBe('FORBIDDEN');
  });
});

describe('API-M2: bundle recipe freshness, same-push bundles and reissues', () => {
  it('keeps the snapshot when a recipe row is newer than the device', async () => {
    const shop = await seedShop('M2 recipe');
    const bundle = await addBundleFixture(shop);
    const now = Date.now();
    const seen = now - 3 * 3_600_000;
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, seen, shop.till.id)
      .run();
    // Another till changes a component quantity after this device last synced.
    await env.DB.prepare(
      'UPDATE bundle_items SET qty_milli = 2000, updated_at = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.bundleItem1, now - 2 * 3_600_000)
      .run();
    const sale = bundleSaleOps(shop, shop.till, 1, bundle, {
      now: now - 3_600_000,
    });
    const res = await pushOk(shop.till, sale);
    expect(res.results.map((row) => row.error_code ?? null)).toEqual(
      sale.map(() => null),
    );
  });

  it('sees a bundle created earlier in the same push', async () => {
    const shop = await seedShop('M2 same push');
    const now = Date.now();
    // The device has pulled everything up to now; the bundle creation is a local action.
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, now, shop.till.id)
      .run();
    const bundleId = newId(now);
    const itemId = newId(now);
    const createTx = newId(now);
    const created = await pushOk(shop.till, [
      op(
        'products',
        'upsert',
        productRow(
          bundleId,
          {
            sku: 'SAME-1',
            kind: 'bundle',
            track_stock: 0,
            price: 3000,
            created_at: now - 1800_000,
            updated_at: now - 1800_000,
          },
          now - 1800_000,
        ),
        { tx_id: createTx, base_rev: 0, changed_fields: [] },
      ),
      op(
        'bundle_items',
        'upsert',
        {
          id: itemId,
          bundle_id: bundleId,
          component_product_id: IDS.product,
          qty_milli: 1000,
          sort_order: 0,
          created_at: now - 1800_000,
          updated_at: now - 1800_000,
          deleted_at: null,
          updated_by: IDS.owner,
        },
        { tx_id: createTx, base_rev: 0, changed_fields: [] },
      ),
    ]);
    expect(created.results.map((row) => row.error_code ?? null)).toEqual([
      null,
      null,
    ]);
    const saleId = newId(now);
    const tx = newId(now);
    const group = newId(now);
    const sale = {
      id: saleId,
      invoice_no: `INV-${shop.till.code}-7`,
      invoice_seq: 7,
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      customer_id: null,
      business_date: businessDate(now),
      created_at: now,
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 3000,
      item_discount_total: 0,
      bundle_discount_total: 0,
      subtotal: 3000,
      bill_discount_type: null,
      bill_discount_value: 0,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      tax_inclusive: 0,
      rounding: 0,
      total: 3000,
      paid_total: 3000,
      udhaar_amount: 0,
      cash_tendered: 3000,
      change_given: 0,
      replaces_sale_id: null,
      note: '',
    };
    const line = {
      id: newId(now),
      sale_id: saleId,
      line_no: 1,
      product_id: IDS.product,
      business_date: sale.business_date,
      name_snapshot: 'Phone',
      sku_snapshot: 'PHN-0001',
      qty_milli: 1000,
      unit_price: 3000,
      gross: 3000,
      discount_type: null,
      discount_value: 0,
      discount: 0,
      net: 3000,
      bill_discount_alloc: 0,
      tax_alloc: 0,
      rounding_alloc: 0,
      unit_cost_snapshot: 0,
      below_cost: 0,
      serial: '',
      warranty_until: null,
      created_at: now,
      bundle_id: bundleId,
      bundle_group: group,
      bundle_name: 'Same push bundle',
      bundle_qty: 1,
      bundle_price: 3000,
      bundle_discount: 0,
      bundle_component_qty_milli: 1000,
    };
    const payment = {
      id: newId(now),
      direction: 'in',
      method: 'cash',
      purpose: 'sale',
      amount: 3000,
      cash_tendered: 3000,
      change_given: 0,
      reference: '',
      sale_id: saleId,
      refund_id: null,
      purchase_id: null,
      supplier_return_id: null,
      party_type: null,
      party_id: null,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.cashier,
      business_date: sale.business_date,
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      op('sales', 'insert', sale, { tx_id: tx }),
      op('sale_lines', 'insert', line, { tx_id: tx }),
      op('payments', 'insert', payment, { tx_id: tx }),
    ]);
    expect(res.results.map((row) => row.error_code ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('refuses a reissue whose bundle snapshot differs from the replaced sale', async () => {
    const shop = await seedShop('M2 reissue');
    const bundle = await addBundleFixture(shop);
    const original = bundleSaleOps(shop, shop.till, 1, bundle);
    await pushOk(shop.till, original);
    const replacedId = String(original[0]?.row?.id ?? '');
    const replacement = bundleSaleOps(shop, shop.till, 2, bundle, {
      replacesSaleId: replacedId,
      bundlePrice: 250000,
    });
    const replacementId = String(replacement[0]?.row?.id ?? '');
    const tx = String(replacement[0]?.tx_id ?? '');
    const wrong = await pushOk(shop.till, [
      ...replacement,
      ...reissueVoid(shop, replacedId, replacementId, tx),
    ]);
    expect(wrong.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  });
});

/** A void pointing at a replacement sale, with its reversal payment. */
function reissueVoid(
  shop: Shop,
  saleId: string,
  replacementId: string,
  tx: string,
) {
  const now = Date.now();
  const date = businessDate(now);
  const rows = [
    op(
      'sale_voids',
      'insert',
      {
        id: newId(),
        sale_id: saleId,
        reason: 'Reissue',
        replacement_sale_id: replacementId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: date,
        created_at: now,
      },
      { tx_id: tx },
    ),
    op(
      'payments',
      'insert',
      {
        id: newId(),
        direction: 'out',
        method: 'cash',
        purpose: 'void',
        amount: 200000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: saleId,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: null,
        party_id: null,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.owner,
        business_date: date,
        created_at: now,
      },
      { tx_id: tx },
    ),
  ];
  return rows;
}

describe('API-M3: Cloudflare address lookup paginates', () => {
  it('finds an address on a later page instead of asking for 1,000 per page', async () => {
    const email = `page-${Date.now()}@example.com`;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        urls.push(`${url.pathname}?${url.searchParams.toString()}`);
        const page = Number(url.searchParams.get('page'));
        const result =
          page === 2
            ? [{ id: 'addr-2', email, verified: '2026-08-01T10:00:00Z' }]
            : [];
        return new Response(
          JSON.stringify({
            success: true,
            result,
            result_info: { page, total_pages: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      const request = await createShopRequest(env, {
        shop_name: 'Paged email',
        owner_name: 'Owner',
        email,
        phone: '+923001234567',
        city: 'Lahore',
        business_type: 'mobile',
        note: '',
      });
      const proxied = new Proxy(env, {
        get(target, prop, receiver) {
          if (prop === 'EMAIL_ROUTING_TOKEN') return 'test-token';
          return Reflect.get(target, prop, receiver);
        },
      });
      const added = await addRequestEmail(
        proxied,
        request.id,
        'operator@example.com',
      );
      expect(added.already_added).toBe(false);
      expect(added.verified).toBe(true);
      expect(urls[0]).toContain('per_page=50');
      expect(urls.some((url) => url.includes('page=2'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('API-M4: chained reissues are deleted children first', () => {
  it('deletes C → B → A without an immediate foreign-key failure', async () => {
    const shop = await seedShop('M4 reissues');
    const now = Date.now();
    const insert = (id: string, replaces: string | null) =>
      env.DB.prepare(
        `INSERT INTO sales (tenant_id, id, invoice_no, invoice_seq, branch_id, device_id, staff_id, business_date, created_at, line_count, items_qty_milli, gross_total, item_discount_total, subtotal, total, paid_total, replaces_sale_id)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, '2026-11-20', ?7, 1, 1000, 100, 0, 100, 100, 100, ?8)`,
      ).bind(
        shop.tenantId,
        id,
        `CHN-${id}`,
        shop.branchId,
        shop.till.id,
        IDS.owner,
        now,
        replaces,
      );
    // A is the parent with the lowest rowid; C must be deleted first.
    await env.DB.batch([
      insert('chain-a', null),
      insert('chain-b', 'chain-a'),
      insert('chain-c', 'chain-b'),
    ]);
    await setStatus(shop.tenantId, 'deleting');
    for (let i = 0; i < 3; i += 1) await pruneAll(env, Date.now());
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1 AND id LIKE 'chain-%'",
        shop.tenantId,
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare('SELECT status FROM tenants WHERE id = ?1')
        .bind(shop.tenantId)
        .first<{ status: string }>(),
    ).toEqual({ status: 'deleted' });
  });
});

describe('API-M5: read-only cutoff is the same in either order', () => {
  it('persists the acknowledgement on a rejected push-first', async () => {
    const shop = await seedShop('M5 push first');
    const now = Date.now();
    await setStatus(shop.tenantId, 'read_only', now - 60_000);
    const late = saleOps(shop, shop.till, 1, { now: now + 3_600_000 });
    const res = await push(shop.till, late);
    expect(res.status).toBe(403);
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND id = ?2 AND read_only_seen_at IS NOT NULL',
        shop.tenantId,
        shop.till.id,
      ),
    ).toBe(1);
    // Ops rung before the till learned the status are kept.
    const early = saleOps(shop, shop.till, 2, { now: now - 120_000 });
    const ok = await pushOk(shop.till, early);
    expect(ok.results.map((row) => row.result)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    // An op rung after it learned is still refused.
    expect((await push(shop.till, late)).status).toBe(403);
  });
});

describe('API-M6: device-code CAS and Access JWT hardening', () => {
  it('retries the code allocation when another device claims it first', async () => {
    const shop = await seedShop('M6 codes');
    const branchId = newId();
    await env.DB.prepare(
      "INSERT INTO branches (tenant_id, id, name, bill_prefix, created_at, updated_at) VALUES (?1, ?2, 'Second', 'SEC', 1, 1)",
    )
      .bind(shop.tenantId, branchId)
      .run();
    const base = tenantDb(env, await tenantRow(shop.tenantId));
    let raced = false;
    const racing = {
      ...base,
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await base.batch(statements);
        if (!raced) {
          raced = true;
          await base.run(
            'INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code) VALUES (?1, ?2, ?3)',
            branchId,
            'A',
          );
        }
        return result;
      },
    } as typeof base;
    expect(await allocateDeviceCode(racing, branchId)).toBe('B');
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM branch_device_codes WHERE tenant_id = ?1 AND branch_id = ?2 AND device_code IN (?3, ?4)',
        shop.tenantId,
        branchId,
        'A',
        'B',
      ),
    ).toBe(2);
  });

  it('refuses malformed JWT shapes and survives a JWKS outage', async () => {
    const team = 'team-y.cloudflareaccess.com';
    const enc = (value: unknown) =>
      base64url(new TextEncoder().encode(JSON.stringify(value)));
    const header = enc({ alg: 'RS256', kid: 'k1' });
    const claims = enc({
      email: 'a@b.c',
      aud: ['aud'],
      iss: `https://${team}`,
    });
    const opts = {
      teamDomain: team,
      aud: 'aud',
      fetcher: async () => {
        throw new Error('JWKS down');
      },
    };
    resetJwksCache();
    const nullPayload = `${header}.${base64url(
      new TextEncoder().encode('null'),
    )}.AAAA`;
    expect(await verifyAccessJwt(nullPayload, opts)).toBeNull();
    expect(await verifyAccessJwt(`${header}.${enc(1)}.AAAA`, opts)).toBeNull();
    expect(
      await verifyAccessJwt(
        `${enc({ alg: 'RS256', kid: 7 })}.${claims}.AAAA`,
        opts,
      ),
    ).toBeNull();
    expect(await verifyAccessJwt(`${header}.${claims}.AAAA`, opts)).toBeNull();
  });
});

describe('API-L6 / L7 / L8 / L9', () => {
  it('serialises the status the client sees for a thrown error', () => {
    expect(statusForError(new TypeError('boom'))).toBe(500);
    expect(statusForError(new SyntaxError('bad json'))).toBe(400);
    expect(
      statusForError(
        new Error("exceeded D1's free tier daily row write limit"),
      ),
    ).toBe(503);
  });

  it('pages the backup listing instead of truncating at 1,000 keys', async () => {
    const keys = Array.from({ length: 1_205 }, (_, i) => ({
      key: `d1/backup-${i}.sql`,
      size: 1,
      uploaded: new Date(1_700_000_000_000 + i),
    }));
    const pages = [keys.slice(0, 1_000), keys.slice(1_000)];
    const bucket = {
      list: async ({ cursor }: { cursor?: string } = {}) => {
        const page = cursor ? pages[1] : pages[0];
        return {
          objects: page ?? [],
          truncated: !cursor,
          cursor: cursor ? '' : 'next',
        };
      },
    } as unknown as Env['BACKUPS'];
    const objects = await listBackupObjects(bucket, 'd1/');
    expect(objects).toHaveLength(1_205);
  });

  it('does not touch the file counter of a concurrent upload reservation', async () => {
    const shop = await seedShop('L9 gc race');
    const tenant = await tenantRow(shop.tenantId);
    const orphan = `products/${IDS.product}/${'d'.repeat(64)}.webp`;
    await env.FILES.put(`t/${shop.tenantId}/${orphan}`, 'abc');
    // A reservation lands after the tenant row the GC will be given was read.
    await env.DB.prepare(
      'UPDATE tenants SET file_bytes = 500, files_initialized = 1 WHERE id = ?1',
    )
      .bind(shop.tenantId)
      .run();
    const stale = { ...tenant, file_bytes: 100 };
    const result = await gcTenantFiles(env, stale, {
      now: Date.now() + 2 * DAY,
      dryRun: false,
    });
    expect(result.deleted).toBe(1);
    expect(
      await env.DB.prepare('SELECT file_bytes FROM tenants WHERE id = ?1')
        .bind(shop.tenantId)
        .first<{ file_bytes: number }>(),
    ).toEqual({ file_bytes: 497 });
  });

  it('includes repaired stock in the average cost of a later costed movement', async () => {
    const shop = await seedShop('L9 repair');
    const now = Date.now();
    // Stock on hand with an average cost of 1000.
    const seedAt = now + 1_000;
    const seedId = newId(seedAt);
    const seedTx = newId(seedAt);
    await pushOk(shop.till, [
      op(
        'purchases',
        'insert',
        {
          id: seedId,
          supplier_id: IDS.supplier,
          supplier_invoice_no: '',
          other_charges: 0,
          total: 3000,
          paid_now: 0,
          paid_method: null,
          line_count: 1,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(seedAt),
          created_at: seedAt,
        },
        { tx_id: seedTx },
      ),
      op(
        'purchase_lines',
        'insert',
        {
          id: newId(seedAt),
          purchase_id: seedId,
          line_no: 1,
          product_id: IDS.product,
          qty_milli: 3000,
          unit_cost: 1000,
          line_total: 3000,
          charges_alloc: 0,
          landed_unit_cost: 1000,
          created_at: seedAt,
        },
        { tx_id: seedTx },
      ),
      op(
        'ledger_entries',
        'insert',
        {
          id: newId(seedAt),
          party_type: 'supplier',
          party_id: IDS.supplier,
          source_type: 'purchase',
          source_id: seedId,
          amount: 3000,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(seedAt),
          created_at: seedAt,
        },
        { tx_id: seedTx },
      ),
    ]);
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
    )
      .bind(shop.tenantId, now + 2_000, shop.till.id)
      .run();
    const sale = saleOps(shop, shop.till, 1, { now: now + 3_000 });
    const line = sale[1]?.row;
    if (line) line.unit_cost_snapshot = 1000;
    const purchaseId = newId(now);
    const tx = newId(now);
    const at = now + 4_000;
    const purchase = {
      id: purchaseId,
      supplier_id: IDS.supplier,
      supplier_invoice_no: '',
      other_charges: 0,
      total: 3000,
      paid_now: 0,
      paid_method: null,
      line_count: 1,
      note: '',
      branch_id: shop.branchId,
      device_id: shop.till.id,
      staff_id: IDS.owner,
      business_date: businessDate(at),
      created_at: at,
    };
    const purchaseLine = {
      id: newId(now),
      purchase_id: purchaseId,
      line_no: 1,
      product_id: IDS.product,
      qty_milli: 1000,
      unit_cost: 3000,
      line_total: 3000,
      charges_alloc: 0,
      landed_unit_cost: 3000,
      created_at: at,
    };
    const expected = nextAvgCost({
      on_hand_milli: 2000,
      avg_cost: 1000,
      qty_milli: 1000,
      unit_cost: 3000,
    });
    const res = await pushOk(shop.till, [
      ...sale,
      op('purchases', 'insert', purchase, { tx_id: tx }),
      op('purchase_lines', 'insert', purchaseLine, { tx_id: tx }),
      op(
        'ledger_entries',
        'insert',
        {
          id: newId(now),
          party_type: 'supplier',
          party_id: IDS.supplier,
          source_type: 'purchase',
          source_id: purchaseId,
          amount: 3000,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.owner,
          business_date: businessDate(at),
          created_at: at,
        },
        { tx_id: tx },
      ),
    ]);
    expect(res.results.map((row) => row.error_code ?? null)).toEqual(
      new Array(res.results.length).fill(null),
    );
    expect(
      await env.DB.prepare(
        'SELECT avg_cost FROM products WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, IDS.product)
        .first<{ avg_cost: number }>(),
    ).toEqual({ avg_cost: expected });
  });
});

describe('API-L3: reopening a request is a compare-and-swap', () => {
  it('refuses a second reopen and an email that is open elsewhere', async () => {
    const email = `reopen-${Date.now()}@example.com`;
    const fields = {
      shop_name: 'Reopen shop',
      owner_name: 'Owner',
      email,
      phone: '+923001234567',
      city: 'Lahore',
      business_type: 'mobile',
      note: '',
    };
    const first = await createShopRequest(env, fields);
    await api(`/admin/shop-requests/${first.id}/reject`, {
      method: 'POST',
      json: { reason: 'Duplicate' },
    });
    // The owner submits a second request with the same address; it holds the active
    // email slot, so reopening the first one would break the unique index.
    const second = await createShopRequest(env, fields);
    expect(second.id).not.toBe(first.id);
    expect(
      (
        await api(`/admin/shop-requests/${first.id}/reopen`, {
          method: 'POST',
          json: { reason: 'Again' },
        })
      ).status,
    ).toBe(409);
    await api(`/admin/shop-requests/${second.id}/reject`, {
      method: 'POST',
      json: { reason: 'Duplicate' },
    });
    expect(
      (
        await api(`/admin/shop-requests/${first.id}/reopen`, {
          method: 'POST',
          json: { reason: 'Again' },
        })
      ).status,
    ).toBe(200);
    // A lost CAS: the row is no longer rejected.
    expect(
      (
        await api(`/admin/shop-requests/${first.id}/reopen`, {
          method: 'POST',
          json: { reason: 'Again' },
        })
      ).status,
    ).toBe(409);
  });
});

describe('API-L4: last_seen_at is budgeted behind the tenant gate', () => {
  it('does not write a suspended shop request', async () => {
    const shop = await seedShop('L4 gate');
    await env.DB.prepare(
      'UPDATE devices SET last_seen_at = 0 WHERE tenant_id = ?1',
    )
      .bind(shop.tenantId)
      .run();
    await setStatus(shop.tenantId, 'suspended');
    expect((await api('/me', { token: shop.till.id })).status).toBe(401);
    expect((await api('/me', { token: shop.till.token })).status).toBe(403);
    expect(
      await env.DB.prepare(
        'SELECT last_seen_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, shop.till.id)
        .first<{ last_seen_at: number | null }>(),
    ).toEqual({ last_seen_at: 0 });
  });
});

describe('API-L5: a rejected transaction is not visible to a later close', () => {
  it('rejects a day close that counts a payment from a rejected transaction', async () => {
    const shop = await seedShop('L5 close');
    const now = Date.now();
    const t0 = now - 120_000;
    const sale = saleOps(shop, shop.till, 1, { now: t0 });
    await pushOk(shop.till, sale);
    const badPayment = {
      ...(sale[2]?.row ?? {}),
      id: newId(),
      sale_id: null,
      direction: 'out',
      purpose: 'sale',
      amount: 5000,
      cash_tendered: 5000,
      change_given: 0,
      created_at: t0 + 2_000,
    };
    const close = {
      id: newId(),
      device_id: shop.till.id,
      branch_id: shop.branchId,
      staff_id: IDS.owner,
      business_date: businessDate(now),
      period_start: t0 + 1,
      period_end: now,
      opening_cash: 0,
      cash_sales: 5000,
      udhaar_cash_in: 0,
      pay_ins: 0,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 0,
      expected_cash: 5000,
      counted_cash: 5000,
      difference: 0,
      denominations_json: null,
      note: '',
      created_at: now,
    };
    const res = await pushOk(shop.till, [
      op('payments', 'insert', badPayment),
      op('day_closes', 'insert', close),
    ]);
    expect(res.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    expect(res.results[1]?.error_code).toBe('CONSTRAINT_FAILED');
  });
});

describe('API-L6: empty operator bodies are allowed, malformed ones are not', () => {
  it('approves an empty body and refuses malformed JSON on approve and files/gc', async () => {
    const request = await createShopRequest(env, {
      shop_name: 'Empty body shop',
      owner_name: 'Owner',
      email: `empty-${Date.now()}@example.com`,
      phone: '+923001234567',
      city: 'Lahore',
      business_type: 'mobile',
      note: '',
    });
    await env.DB.prepare(
      "UPDATE shop_requests SET status = 'email_verified', email_verified_at = ?2 WHERE id = ?1",
    )
      .bind(request.id, Date.now())
      .run();
    const approved = await api(`/admin/shop-requests/${request.id}/approve`, {
      method: 'POST',
    });
    expect(approved.status).toBe(200);
    const shop = await seedShop('L6 gc');
    const malformed = await api(`/admin/tenants/${shop.tenantId}/files/gc`, {
      method: 'POST',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.status).toBe(400);
    expect(
      (await json<{ error: { code: string } }>(malformed)).error.code,
    ).toBe('VALIDATION_FAILED');
    const empty = await api(`/admin/tenants/${shop.tenantId}/files/gc`, {
      method: 'POST',
    });
    expect(empty.status).toBe(200);
    expect(await json<{ examined: number }>(empty)).toMatchObject({
      examined: 0,
    });
  });
});

describe('API-M2: restock is uniform across a bundle group', () => {
  it('refuses a partial restock and accepts all-or-nothing', async () => {
    const shop = await seedShop('M2 restock');
    const bundle = await addBundleFixture(shop);
    const sale = bundleSaleOps(shop, shop.till, 1, bundle);
    await pushOk(shop.till, sale);
    const saleId = String(sale[0]?.row?.id);
    const saleLines = sale
      .filter((entry) => entry.tbl === 'sale_lines')
      .map((entry) => String(entry.row?.id));
    const refundOps = (restocks: number[]) => {
      const refundId = newId();
      const tx = newId();
      const now = Date.now();
      const date = businessDate(now);
      const ops = [
        op(
          'refunds',
          'insert',
          {
            id: refundId,
            sale_id: saleId,
            kind: 'partial',
            reason: 'Return',
            method: 'cash',
            exact_amount: 200000,
            udhaar_part: 0,
            rounding: 0,
            amount: 200000,
            branch_id: shop.branchId,
            device_id: shop.till.id,
            staff_id: IDS.owner,
            business_date: date,
            created_at: now,
          },
          { tx_id: tx },
        ),
      ];
      saleLines.forEach((saleLineId, index) => {
        ops.push(
          op(
            'refund_lines',
            'insert',
            {
              id: newId(),
              refund_id: refundId,
              sale_line_id: saleLineId,
              qty_milli: 1000,
              amount: 50000,
              restock: restocks[index] ?? 1,
              created_at: now,
            },
            { tx_id: tx },
          ),
        );
      });
      ops.push(
        op(
          'payments',
          'insert',
          {
            id: newId(),
            direction: 'out',
            method: 'cash',
            purpose: 'refund',
            amount: 200000,
            cash_tendered: null,
            change_given: null,
            reference: '',
            sale_id: null,
            refund_id: refundId,
            purchase_id: null,
            supplier_return_id: null,
            party_type: null,
            party_id: null,
            note: '',
            branch_id: shop.branchId,
            device_id: shop.till.id,
            staff_id: IDS.owner,
            business_date: date,
            created_at: now,
          },
          { tx_id: tx },
        ),
      );
      return ops;
    };
    const mixed = await pushOk(shop.till, refundOps([0, 1, 1, 1]));
    expect(mixed.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
    const none = await pushOk(shop.till, refundOps([0, 0, 0, 0]));
    expect(none.results[0]?.error_code ?? null).toBeNull();
  });
});

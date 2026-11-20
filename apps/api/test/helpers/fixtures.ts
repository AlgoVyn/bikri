/**
 * Test tenants for the Worker tests and the isolation suite (10 §8): every shop gets the same
 * row ids for its catalogue (colliding ids, SKUs, barcodes, bill prefixes and invoice numbers),
 * two devices (admin + till) and an owner and a cashier.
 */
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { CLIENT_SCHEMA_VERSION, newId } from '@bikri/core';
import { newDeviceToken, sha256Hex } from '../../src/auth/crypto.ts';
import { codeFromIndex } from '../../src/auth/deviceCodes.ts';
import { createTenant } from '../../src/platform/createTenant.ts';
import type { TenantStatus } from '../../src/types.ts';

export const API = 'https://algovyn.com/bikri/api';

/** Ids every fixture shop uses (they collide across tenants on purpose). */
export const IDS = {
  owner: '01JB0000000000000000000001',
  cashier: '01JB0000000000000000000002',
  category: '01JB0000000000000000000003',
  product: '01JB0000000000000000000004',
  barcode: '01JB0000000000000000000005',
  customer: '01JB0000000000000000000006',
  supplier: '01JB0000000000000000000007',
  bundle: '01JB0000000000000000000008',
  component2: '01JB0000000000000000000009',
  component3: '01JB0000000000000000000010',
  component4: '01JB0000000000000000000011',
  bundleItem1: '01JB0000000000000000000012',
  bundleItem2: '01JB0000000000000000000013',
  bundleItem3: '01JB0000000000000000000014',
  bundleItem4: '01JB0000000000000000000015',
} as const;

/** Canonical base64 for a 32-byte hash and 16-byte salt, as hashPin() produces. */
export const SEED_PIN_HASH = `${'a'.repeat(43)}=`;
export const SEED_PIN_SALT = `${'a'.repeat(22)}==`;

export type Shop = {
  tenantId: string;
  slug: string;
  branchId: string;
  admin: { id: string; token: string; code: string };
  till: { id: string; token: string; code: string };
  ownerCode: string;
  ownerEmail: string | null;
};

let counter = 0;

async function addDevice(
  tenantId: string,
  branchId: string,
  code: string,
  isAdmin: boolean,
  now: number,
  kind: 'till' | 'support' = 'till',
  expiresAt: number | null = null,
): Promise<{ id: string; token: string; code: string }> {
  const id = newId(now);
  const token = newDeviceToken();
  await env.DB.prepare(
    `INSERT INTO devices (tenant_id, id, name, branch_id, device_code, token_hash, is_admin, kind, expires_at, enrolled_at, enrolled_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'operator:test', ?10, ?10)`,
  )
    .bind(
      tenantId,
      id,
      isAdmin ? 'Counter 1' : 'Counter 2',
      branchId,
      code,
      await sha256Hex(token),
      isAdmin ? 1 : 0,
      kind,
      expiresAt,
      now,
    )
    .run();
  return { id, token, code };
}

export async function addSupportDevice(shop: Shop, expiresAt: number) {
  counter += 1;
  return addDevice(
    shop.tenantId,
    shop.branchId,
    codeFromIndex(100 + counter),
    false,
    Date.now(),
    'support',
    expiresAt,
  );
}

/** A ready shop: tenant, shop row, owner + cashier, a category, product, barcode, customer, supplier. */
export async function seedShop(
  name = 'Shop',
  opts: {
    status?: TenantStatus;
    ownerEmail?: string | null;
    budget?: number;
  } = {},
): Promise<Shop> {
  const now = Date.now();
  counter += 1;
  const slug =
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter}-${Math.floor(Math.random() * 1e6)}`.slice(
      0,
      30,
    );
  const { tenant, owner_code } = await createTenant(
    env,
    {
      slug,
      display_name: name,
      owner_email:
        opts.ownerEmail === undefined
          ? `owner-${counter}@example.com`
          : opts.ownerEmail,
      daily_write_budget: opts.budget ?? 7000,
      note: '',
      created_by_email: 'operator@example.com',
    },
    now,
  );
  const t = tenant.id;
  const branch = await env.DB.prepare(
    'SELECT id FROM branches WHERE tenant_id = ?1',
  )
    .bind(t)
    .first<{ id: string }>();
  const branchId = branch?.id ?? '';
  const run = (sql: string, ...params: unknown[]) =>
    env.DB.prepare(sql)
      .bind(t, ...params)
      .run();
  await run(
    `INSERT INTO shop (tenant_id, id, name, business_type, phone, address, setup_completed_at, created_at, updated_at) VALUES (?1, 'shop', ?2, 'mobile', '03001234567', 'Hall Road', ?3, ?3, ?3)`,
    name,
    now,
  );
  for (const [id, role] of [
    [IDS.owner, 'owner'],
    [IDS.cashier, 'cashier'],
  ] as const) {
    await run(
      `INSERT INTO staff (tenant_id, id, name, role, pin_hash, pin_salt, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      id,
      role === 'owner' ? 'Owner' : 'Cashier',
      role,
      SEED_PIN_HASH,
      SEED_PIN_SALT,
      now,
    );
  }
  await run(
    `INSERT INTO categories (tenant_id, id, name_en, created_at, updated_at) VALUES (?1, ?2, 'Phones', ?3, ?3)`,
    IDS.category,
    now,
  );
  await run(
    `INSERT INTO products (tenant_id, id, name_en, category_id, sku, price, created_at, updated_at, rev) VALUES (?1, ?2, ?3, ?4, 'PHN-0001', 150000, ?5, ?5, 3)`,
    IDS.product,
    `${name} phone`,
    IDS.category,
    now,
  );
  await run(
    `INSERT INTO product_barcodes (tenant_id, id, product_id, barcode, created_at, updated_at) VALUES (?1, ?2, ?3, '8961234567890', ?4, ?4)`,
    IDS.barcode,
    IDS.product,
    now,
  );
  await run(
    `INSERT INTO customers (tenant_id, id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
    IDS.customer,
    `${name} customer`,
    now,
  );
  await run(
    `INSERT INTO suppliers (tenant_id, id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
    IDS.supplier,
    `${name} supplier`,
    now,
  );
  const admin = await addDevice(t, branchId, 'A', true, now);
  const till = await addDevice(t, branchId, 'B', false, now);
  if (opts.status && opts.status !== 'active') await setStatus(t, opts.status);
  return {
    tenantId: t,
    slug,
    branchId,
    admin,
    till,
    ownerCode: owner_code.code,
    ownerEmail: tenant.owner_email,
  };
}

export type BundleFixture = {
  bundleId: string;
  componentIds: [string, string, string, string];
  itemIds: [string, string, string, string];
};

/**
 * Adds the four-component bundle every fixture tenant uses in the isolation suite
 * (10 §8 I25–I27). The ids collide across tenants on purpose; the customer/product
 * names carry the shop name so a leak is visible even when the ids match.
 */
export async function addBundleFixture(
  shop: Shop,
  label = 'Bundle',
): Promise<BundleFixture> {
  const now = Date.now();
  const componentIds: BundleFixture['componentIds'] = [
    IDS.product,
    IDS.component2,
    IDS.component3,
    IDS.component4,
  ];
  const itemIds: BundleFixture['itemIds'] = [
    IDS.bundleItem1,
    IDS.bundleItem2,
    IDS.bundleItem3,
    IDS.bundleItem4,
  ];
  const statements = [
    env.DB.prepare(
      `INSERT INTO products (tenant_id, id, name_en, sku, price, kind, track_stock, last_cost, created_at, updated_at, rev)
       VALUES (?1, ?2, ?3, 'BND-0001', 200000, 'bundle', 0, 0, ?4, ?4, 1)`,
    ).bind(shop.tenantId, IDS.bundle, `${label} bundle`, now),
  ];
  for (const [index, id] of componentIds.slice(1).entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO products (tenant_id, id, name_en, sku, price, last_cost, created_at, updated_at, rev)
         VALUES (?1, ?2, ?3, ?4, 50000, 0, ?5, ?5, 1)`,
      ).bind(
        shop.tenantId,
        id,
        `${label} component ${index + 2}`,
        `CMP-000${index + 2}`,
        now,
      ),
    );
  }
  for (const [index, id] of itemIds.entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO bundle_items (tenant_id, id, bundle_id, component_product_id, qty_milli, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1000, ?5, ?6, ?6)`,
      ).bind(shop.tenantId, id, IDS.bundle, componentIds[index], index, now),
    );
  }
  await env.DB.batch(statements);
  return { bundleId: IDS.bundle, componentIds, itemIds };
}

export async function setStatus(
  tenantId: string,
  status: TenantStatus,
  at = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    'UPDATE tenants SET status = ?2, status_changed_at = ?3 WHERE id = ?1',
  )
    .bind(tenantId, status, at)
    .run();
}

/** The allowed origin in Worker tests (vitest.config.ts). */
export const TEST_ORIGIN = 'https://bikri.test';

export function api(
  path: string,
  init: RequestInit & { token?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (!headers.has('origin')) headers.set('origin', TEST_ORIGIN);
  // Pull/snapshot reject a client below MIN_CLIENT_SCHEMA; tests act as a current till.
  if (!headers.has('x-bikri-schema'))
    headers.set('x-bikri-schema', String(CLIENT_SCHEMA_VERSION));
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return SELF.fetch(`${API}${path}`, { ...init, headers, body });
}

export async function json<T = Record<string, unknown>>(
  res: Response,
): Promise<T> {
  return (await res.json()) as T;
}

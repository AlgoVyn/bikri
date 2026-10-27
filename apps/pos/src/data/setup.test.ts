import { hashPin } from '@bikri/core';
import { openTenantDb } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalTenant, tenantInfo } from './localTenant.ts';
import {
  finishSetup,
  isSetupDone,
  loadSetupDraft,
  SetupAlreadyDoneError,
  type SetupInput,
  saveSetupDraft,
} from './setup.ts';
import { dropTestDbs, freshDb } from './testDb.ts';

afterEach(dropTestDbs);

const NOW = Date.UTC(2026, 9, 27, 9, 0);

const input = (over: Partial<SetupInput> = {}): SetupInput => ({
  shop: {
    name: ' Algovyn Mobiles ',
    business_type: 'mobile',
    phone: '+923001234567',
    address: 'Shop 12, Hall Road, Lahore',
    city: 'Lahore',
    ntn: '',
    strn: '',
  },
  owner: { name: 'Adnan', pin: '4826' },
  receipt: {
    header: '',
    footer: 'Shukriya!',
    tax_rate_bp: 1700,
    inclusive: false,
    round_total_to: 100,
  },
  product: null,
  ...over,
});

async function devDb() {
  const db = openTenantDb('dev');
  await ensureLocalTenant(db, NOW);
  return db;
}

describe('local tenant (dev)', () => {
  it('creates kv.tenant, kv.device and the default branch once, without outbox ops', async () => {
    const db = await devDb();
    await ensureLocalTenant(db, NOW + 1);
    expect(await tenantInfo(db)).toEqual({
      id: 'dev',
      display_name: 'Dev Shop',
    });
    expect(await db.branches.count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    db.close();
    await db.delete();
  });

  it('does nothing for a real tenant', async () => {
    const db = freshDb();
    await ensureLocalTenant(db);
    expect(await tenantInfo(db)).toBeNull();
  });
});

describe('finishSetup (screens/01)', () => {
  it('writes shop, branch upsert, owner, expense categories and ops in one action', async () => {
    const db = await devDb();
    expect(await isSetupDone(db)).toBe(false);
    await saveSetupDraft(db, {
      step: 3,
      shop: input().shop,
      owner: { name: 'Adnan' },
      receipt: input().receipt,
    });
    const pinHash = await hashPin('4826', 1000);
    const { owner } = await finishSetup(db, input(), { now: NOW, pinHash });
    expect(await isSetupDone(db)).toBe(true);
    const shop = await db.shop.get('shop');
    expect(shop).toMatchObject({
      name: 'Algovyn Mobiles',
      tax_rate_bp: 1700,
      tax_mode: 'exclusive',
      setup_completed_at: NOW,
    });
    expect(owner).toMatchObject({
      role: 'owner',
      pin_hash: pinHash.pin_hash,
      pin_length: 4,
    });
    expect(await db.expense_categories.count()).toBe(8);
    expect(await loadSetupDraft(db)).toBeNull();
    const ops = await db.outbox.toArray();
    expect(new Set(ops.map((o) => o.tx_id)).size).toBe(1);
    const branchOp = ops.find((o) => o.tbl === 'branches');
    expect(branchOp).toMatchObject({
      kind: 'upsert',
      base_rev: 1,
      changed_fields: ['address', 'phone'],
    });
    expect(
      ops.filter((o) => o.tbl === 'branches' && o.base_rev === 0),
    ).toHaveLength(0);
    expect(ops.map((o) => o.tbl).sort()).toEqual(
      [
        'branches',
        'shop',
        'staff',
        ...Array(8).fill('expense_categories'),
      ].sort(),
    );
    await expect(
      finishSetup(db, input(), { now: NOW, pinHash }),
    ).rejects.toBeInstanceOf(SetupAlreadyDoneError);
    db.close();
    await db.delete();
  });

  it('adds the first product with opening stock and stores inclusive tax only when rate > 0', async () => {
    const db = await devDb();
    const pinHash = await hashPin('4826', 1000);
    const { product } = await finishSetup(
      db,
      input({
        receipt: {
          header: '',
          footer: '',
          tax_rate_bp: 0,
          inclusive: true,
          round_total_to: 1,
        },
        product: {
          name_en: 'Samsung A15',
          price: 4_200_000,
          cost: 3_800_000,
          opening_milli: 5000,
          barcodes: ['8806095'],
        },
      }),
      {
        now: NOW,
        pinHash,
        logo: {
          png: new Blob(['x']),
          sha256: 'ab'.repeat(32),
          bitmap: {
            width: 1,
            height: 1,
            data: new Uint8Array([0]),
            format: 'gray',
          },
        },
      },
    );
    expect((await db.shop.get('shop'))?.tax_mode).toBe('exclusive');
    expect((await db.shop.get('shop'))?.logo_key).toBe(
      `shop/logo-${'ab'.repeat(32)}.png`,
    );
    expect(product?.sku).toMatch(/^SAM-/);
    expect(await db.stock_levels.get(product?.id ?? '')).toMatchObject({
      on_hand_milli: 5000,
    });
    const move = await db.stock_movements.toArray();
    expect(move[0]).toMatchObject({
      reason_code: 'opening',
      unit_cost: 3_800_000,
      business_date: '2026-10-27',
    });
    expect(await db.product_barcodes.count()).toBe(1);
    expect(await db.file_queue.count()).toBe(1);
    const bitmap = (await db.kv.get('logo_bitmap'))?.value as {
      width: number;
      data: ArrayLike<number>;
    };
    expect(bitmap.width).toBe(1);
    expect(Array.from(bitmap.data)).toEqual([0]);
    db.close();
    await db.delete();
  });

  it('refuses to run on a till with no branch or device', async () => {
    const db = freshDb();
    await expect(
      finishSetup(db, input(), { pinHash: await hashPin('4826', 1000) }),
    ).rejects.toThrow(/enrol/);
  });
});

describe('two shops on one browser (I-till, screens/01 AC9)', () => {
  it("keeps each shop's setup, owner and name in its own database", async () => {
    const pinHash = await hashPin('4826', 1000);
    const made = [];
    for (const [tenant, name] of [
      ['01JTENANTAAAAAAAAAAAAAAAAA', 'Algovyn Mobiles'],
      ['01JTENANTBBBBBBBBBBBBBBBBB', 'Hall Road Electronics'],
    ] as const) {
      const db = openTenantDb(tenant);
      await db.branches.put({
        id: 'br1',
        name: 'Main',
        bill_prefix: 'A',
        is_default: 1,
        created_at: 1,
        updated_at: 1,
        rev: 1,
      });
      await db.kv.put({
        key: 'device',
        value: {
          id: 'dev1',
          name: 'C1',
          code: 'A',
          branch_id: 'br1',
          is_admin: true,
        },
      });
      await finishSetup(db, input({ shop: { ...input().shop, name } }), {
        now: NOW,
        pinHash,
      });
      made.push(db);
    }
    const [a, b] = made as [
      ReturnType<typeof openTenantDb>,
      ReturnType<typeof openTenantDb>,
    ];
    expect((await a.shop.get('shop'))?.name).toBe('Algovyn Mobiles');
    expect((await b.shop.get('shop'))?.name).toBe('Hall Road Electronics');
    expect(await a.staff.count()).toBe(1);
    expect(await b.staff.count()).toBe(1);
    const aStaff = (await a.staff.toArray())[0]?.id;
    expect(await b.staff.get(aStaff ?? '')).toBeUndefined();
    for (const db of made) {
      db.close();
      await db.delete();
    }
  });
});

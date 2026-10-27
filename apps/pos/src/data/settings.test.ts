import { hashPin } from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { addProduct, cartTotals, emptyCart, shopMoney } from './cart.ts';
import {
  auditCsv,
  auditList,
  auditSummary,
  SettingsError,
  saveStaff,
  shopSettings,
  staffList,
  updateBranchSettings,
  updateShopLogo,
  updateShopSettings,
} from './settings.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = '2026-10-27';

async function setup(prefix = 'settings') {
  const db = await readyDb(prefix);
  await addShop(db, { name: 'Bikri Mobile', timezone: TZ });
  return db;
}

describe('shop and staff settings (screens/17)', () => {
  it('AC 1/8: saves receipt tax and the next inclusive bill uses it; old rows stay', async () => {
    const db = await setup();
    await db.sales.add({
      id: 'old-sale',
      total: 100000,
      business_date: TODAY,
      created_at: NOW,
      status: 'paid',
    });
    await updateShopSettings(
      db,
      { tax_rate_bp: 1700, tax_mode: 'inclusive' },
      'st-1',
      NOW + 1,
    );
    const shop = await db.shop.get('shop');
    expect(shop).toMatchObject({ tax_rate_bp: 1700, tax_mode: 'inclusive' });
    const audits = await auditList(db, {
      from: TODAY,
      to: TODAY,
      action: 'shop_change',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toContain('tax_rate_bp');
    const product = {
      id: 'p1',
      name_en: 'Phone',
      name_ur: '',
      price: 1170000,
      avg_cost: 0,
      track_stock: 0,
      unit: 'pc',
      sku: 'P-1',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    };
    const cart = addProduct(emptyCart('c1'), product as never, 1000, 'avg');
    const totals = cartTotals(cart, shopMoney(shop));
    expect(totals).toMatchObject({ total: 1170000, tax: 170000 });
    expect((await db.sales.get('old-sale'))?.total).toBe(100000);
  });

  it('validates shop fields and forces tax_mode off when tax is 0', async () => {
    const db = await setup('validation');
    await expect(
      updateShopSettings(db, { name: '  ' }, 'st-1', NOW),
    ).rejects.toMatchObject({ code: 'name' });
    await expect(
      updateShopSettings(db, { tax_rate_bp: 5001 }, 'st-1', NOW),
    ).rejects.toMatchObject({ code: 'tax' });
    await expect(
      updateBranchSettings(
        db,
        'br-1',
        { name: 'Main', bill_prefix: 'a', address: '', phone: '' },
        'st-1',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'prefix' });
    await updateShopSettings(
      db,
      { tax_rate_bp: 0, tax_mode: 'inclusive' },
      'st-1',
      NOW + 1,
    );
    expect((await db.shop.get('shop'))?.tax_mode).toBe('exclusive');
    expect(
      (
        await db.audit_log
          .where('created_at')
          .between(NOW, NOW + 10)
          .toArray()
      ).filter((row) => row.action === 'shop_change'),
    ).toHaveLength(1);
  });

  it('AC 3: cannot remove the last active owner; can add a cashier with a PIN', async () => {
    const db = await setup('staff');
    await expect(
      saveStaff(
        db,
        {
          id: 'st-1',
          name: 'Adnan',
          role: 'manager',
          active: false,
          maxDiscountBp: 500,
          permissions: {},
        },
        'st-1',
        NOW,
      ),
    ).rejects.toBeInstanceOf(SettingsError);
    const pin = await hashPin('2580', 1000);
    const cashier = await saveStaff(
      db,
      {
        name: 'Sana',
        role: 'cashier',
        active: true,
        maxDiscountBp: 0,
        permissions: { 'refund.create': true },
        pin: { ...pin, pin_length: 4 },
      },
      'st-1',
      NOW + 1,
    );
    expect(cashier).toMatchObject({
      name: 'Sana',
      role: 'cashier',
      active: 1,
      permissions_json: JSON.stringify({ 'refund.create': true }),
    });
    const list = await staffList(db);
    expect(list.map((row) => [row.staff.name, row.isLastOwner])).toEqual([
      ['Adnan', true],
      ['Sana', false],
    ]);
    const audits = await auditList(db, {
      from: TODAY,
      to: TODAY,
      action: 'staff_change',
    });
    expect(audits[0]?.summary).toContain('name');
    expect(auditCsv(audits, TZ).split('\r\n')[0]).toBe(
      'time,staff,device,action,entity,summary',
    );
  });
});

describe('settings helpers', () => {
  it('fills shop defaults and maps every stored receipt flag', () => {
    expect(shopSettings(undefined)).toMatchObject({
      tax_mode: 'exclusive',
      receipt_language: 'app',
      number_grouping: 'intl',
      refund_rounding: 'nearest',
      show_payment_details: true,
      show_cashier_on_receipt: true,
      show_you_saved: false,
      print_warranty: false,
    });
    expect(
      shopSettings({
        id: 'shop',
        tax_mode: 'inclusive',
        receipt_language: 'ur',
        number_grouping: 'lakh',
        refund_rounding: 'down',
        round_total_to: 500,
        show_payment_details: 0,
        show_cashier_on_receipt: 0,
        show_you_saved: 1,
        print_warranty: 1,
      } as SyncedRow),
    ).toMatchObject({
      tax_mode: 'inclusive',
      receipt_language: 'ur',
      number_grouping: 'lakh',
      refund_rounding: 'down',
      round_total_to: 500,
      show_payment_details: false,
      show_cashier_on_receipt: false,
      show_you_saved: true,
      print_warranty: true,
    });
  });

  it('rejects a missing shop/branch, saves a valid branch and replaces or removes the logo', async () => {
    const bare = await readyDb('bare');
    await expect(
      updateShopSettings(bare, { name: 'No shop' }, 'st-1', NOW),
    ).rejects.toMatchObject({ code: 'name' });
    const db = await setup('branch');
    const branch = await updateBranchSettings(
      db,
      'br-1',
      {
        name: 'Main',
        bill_prefix: 'MAIN',
        address: 'Hall Road',
        phone: '0300',
      },
      'st-1',
      NOW,
    );
    expect(branch).toMatchObject({ bill_prefix: 'MAIN' });
    await expect(
      updateBranchSettings(
        db,
        'missing',
        { name: 'Main', bill_prefix: 'MAIN', address: '', phone: '' },
        'st-1',
        NOW,
      ),
    ).rejects.toBeInstanceOf(SettingsError);

    const logo = {
      png: new Blob(['png']),
      sha256: 'abc123',
      bitmap: {
        width: 1,
        height: 1,
        data: new Uint8Array([0]),
        format: 'gray' as const,
      },
    };
    await updateShopLogo(db, logo, null, NOW + 1);
    expect((await db.shop.get('shop'))?.logo_key).toBe('shop/logo-abc123.png');
    expect((await db.kv.get('logo_bitmap'))?.value).toBeDefined();
    await updateShopLogo(db, null, 'st-1', NOW + 2);
    expect((await db.shop.get('shop'))?.logo_key).toBeNull();
    expect(await db.kv.get('logo_bitmap')).toBeUndefined();
  });

  it('validates staff input and updates an existing cashier', async () => {
    const db = await setup('staff-more');
    await expect(
      saveStaff(
        db,
        {
          name: ' ',
          role: 'cashier',
          active: true,
          maxDiscountBp: 0,
          permissions: {},
        },
        'st-1',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'name' });
    await expect(
      saveStaff(
        db,
        {
          name: 'X',
          role: 'cashier',
          active: true,
          maxDiscountBp: 10001,
          permissions: {},
        },
        'st-1',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'discount' });
    await expect(
      saveStaff(
        db,
        {
          name: 'X',
          role: 'cashier',
          active: true,
          maxDiscountBp: 0,
          permissions: {},
        },
        'st-1',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'pin' });
    const pin = await hashPin('2580', 1000);
    await expect(
      saveStaff(
        db,
        {
          name: 'X',
          role: 'cashier',
          active: true,
          maxDiscountBp: 0,
          permissions: {},
          pin: { ...pin, pin_length: 3 },
        },
        'st-1',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'pin' });
    const cashier = await saveStaff(
      db,
      {
        name: 'Sana',
        role: 'cashier',
        active: true,
        maxDiscountBp: 500,
        permissions: {},
        pin: { ...pin, pin_length: 4 },
      },
      'st-1',
      NOW + 1,
    );
    const updated = await saveStaff(
      db,
      {
        id: cashier.id,
        name: 'Sana Ali',
        role: 'cashier',
        active: false,
        maxDiscountBp: 1000,
        permissions: { 'report.view': false },
      },
      null,
      NOW + 2,
    );
    expect(updated).toMatchObject({
      name: 'Sana Ali',
      active: 0,
      max_discount_bp: 1000,
      permissions_json: JSON.stringify({ 'report.view': false }),
    });
  });

  it('summarises audit JSON and filters activity by action/staff/device', async () => {
    expect(
      auditSummary({
        id: 'a1',
        before_json: null,
        after_json: '{"a":1}',
      } as SyncedRow),
    ).toBe('a: — → 1');
    expect(
      auditSummary({
        id: 'a2',
        before_json: '{"a":1}',
        after_json: null,
      } as SyncedRow),
    ).toContain('a');
    expect(
      auditSummary({
        id: 'a3',
        before_json: 'bad',
        after_json: 'bad',
      } as SyncedRow),
    ).toBe('');
    expect(
      auditSummary({
        id: 'a4',
        before_json: '{"a":1}',
        after_json: '{"a":1,"b":{"c":2}}',
      } as SyncedRow),
    ).toContain('b: — → {"c":2}');

    const db = await setup('audit');
    await db.audit_log.bulkAdd([
      {
        id: 'a1',
        action: 'shop_change',
        entity: 'shop',
        entity_id: 'shop',
        before_json: '{"name":"A"}',
        after_json: '{"name":"B"}',
        device_id: 'dev-1',
        staff_id: 'st-1',
        created_at: NOW,
      },
      {
        id: 'a2',
        action: 'staff_change',
        entity: 'staff',
        entity_id: 'st-1',
        before_json: null,
        after_json: null,
        device_id: 'missing-device',
        staff_id: 'missing-staff',
        created_at: NOW + 1,
      },
    ] as SyncedRow[]);
    const filtered = await auditList(db, {
      from: TODAY,
      to: TODAY,
      action: 'shop_change',
      staffId: 'st-1',
      deviceId: 'dev-1',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      staffName: 'Adnan',
      deviceName: 'Counter 1',
    });
    const unknown = await auditList(db, {
      from: TODAY,
      to: TODAY,
      action: 'staff_change',
    });
    expect(unknown[0]).toMatchObject({ staffName: '', deviceName: '' });
    const all = await auditList(db, { from: TODAY, to: TODAY });
    expect(all).toHaveLength(2);
    expect(auditCsv(all, TZ)).toContain('shop_change');
  });
});

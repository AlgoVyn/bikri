import { businessDate } from '@bikri/core';
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, BackdateError, startBackdate } from './backdate.ts';
import { addProduct, emptyCart } from './cart.ts';
import { ledgerContext } from './catalog.ts';
import { completeSale, SaleInvalidError } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, sale, shopWithStock } from './testShop.ts';

afterEach(dropTestDbs);

const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };
const TODAY = businessDate(NOW, 'Asia/Karachi');
const YESTERDAY = addDays(TODAY, -1);

async function withCashier() {
  const fx = await shopWithStock('backdate');
  await fx.db.staff.add({
    id: 'st-2',
    name: 'Cashier',
    role: 'cashier',
    active: 1,
    max_discount_bp: 500,
    permissions_json: '{}',
    ...row,
  });
  return fx;
}

describe('record a past sale (D-173)', () => {
  it('starts a cart with the date, attributed cashier and reason; nothing is written to the ledger', async () => {
    const { db } = await withCashier();
    const { cartId } = await startBackdate(db, {
      actorId: 'st-1',
      date: YESTERDAY,
      staffId: 'st-2',
      reason: 'Cashier forgot to enter it',
      now: NOW,
    });
    expect(cartId).toBe('c1');
    const cart = await db.carts.get(cartId);
    expect(cart?.backdate).toEqual({
      business_date: YESTERDAY,
      staff_id: 'st-2',
      reason: 'Cashier forgot to enter it',
    });
    expect(await db.sales.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rejects a non-owner, a future date, an empty reason and an inactive cashier', async () => {
    const { db } = await withCashier();
    await expect(
      startBackdate(db, {
        actorId: 'st-2',
        date: YESTERDAY,
        staffId: 'st-2',
        reason: 'x',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      startBackdate(db, {
        actorId: 'st-1',
        date: addDays(TODAY, 1),
        staffId: 'st-2',
        reason: 'x',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'range' });
    await expect(
      startBackdate(db, {
        actorId: 'st-1',
        date: YESTERDAY,
        staffId: 'st-2',
        reason: '   ',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'reason' });
    await expect(
      startBackdate(db, {
        actorId: 'st-1',
        date: YESTERDAY,
        staffId: 'missing',
        reason: 'x',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'staff' });
    await expect(
      startBackdate(db, {
        actorId: 'st-1',
        date: 'not-a-date',
        staffId: 'st-2',
        reason: 'x',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(BackdateError);
  });

  it('accepts a date older than 30 days (no cap)', async () => {
    const { db } = await withCashier();
    const old = addDays(TODAY, -400);
    const { cartId } = await startBackdate(db, {
      actorId: 'st-1',
      date: old,
      staffId: 'st-2',
      reason: 'Old missed sale',
      now: NOW,
    });
    expect((await db.carts.get(cartId))?.backdate).toEqual({
      business_date: old,
      staff_id: 'st-2',
      reason: 'Old missed sale',
    });
  });

  it('writes the sale on the chosen date, attributes it to the cashier and audits the owner recorder', async () => {
    const { db, ctx, buds } = await withCashier();
    const cart = {
      ...addProduct(emptyCart('c1'), buds, 1000, 'avg'),
      backdate: {
        business_date: YESTERDAY,
        staff_id: 'st-2',
        reason: 'Cashier forgot to enter it',
      },
    };
    await db.carts.put(cart);
    const { sale: written } = await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 350000 }]),
      ctx,
      NOW,
    );
    expect(written).toMatchObject({
      business_date: YESTERDAY,
      staff_id: 'st-2',
      created_at: NOW,
      total: 350000,
    });
    const payment = (await db.payments.toArray())[0];
    expect(payment).toMatchObject({
      purpose: 'sale',
      business_date: YESTERDAY,
      staff_id: 'st-2',
      created_at: NOW,
    });
    const movement = (await db.stock_movements.toArray()).find(
      (m) => m.reason_code === 'sale',
    );
    expect(movement).toMatchObject({
      business_date: YESTERDAY,
      staff_id: 'st-2',
      created_at: NOW,
    });
    const audit = await db.audit_log
      .where('[entity+entity_id]')
      .equals(['sales', String(written.id)])
      .toArray();
    const backdated = audit.find((a) => a.action === 'sale_backdated');
    expect(backdated).toMatchObject({
      entity: 'sales',
      entity_id: written.id,
      staff_id: 'st-1',
      device_id: ctx.device_id,
    });
    expect(JSON.parse(String(backdated?.after_json))).toMatchObject({
      attributed_staff_id: 'st-2',
      business_date: YESTERDAY,
      reason: 'Cashier forgot to enter it',
      recorded_at: NOW,
    });
    expect((await db.outbox.toArray()).some((o) => o.tbl === 'audit_log')).toBe(
      true,
    );
  });

  it('rejects a non-owner recorder, a missing cashier and a reissue cart', async () => {
    const { db, buds } = await withCashier();
    const cashierCtx = await ledgerContext(db, 'st-2');
    const cart = {
      ...addProduct(emptyCart('c1'), buds, 1000, 'avg'),
      backdate: {
        business_date: YESTERDAY,
        staff_id: 'st-2',
        reason: 'Missed',
      },
    };
    await expect(
      completeSale(
        db,
        sale(cart, [{ method: 'cash', amount: 350000 }]),
        cashierCtx,
        NOW,
      ),
    ).rejects.toThrow('backdate permission');
    await expect(
      completeSale(
        db,
        sale(
          {
            ...cart,
            backdate: { ...cart.backdate, staff_id: 'missing' },
          },
          [{ method: 'cash', amount: 350000 }],
        ),
        await ledgerContext(db, 'st-1'),
        NOW,
      ),
    ).rejects.toThrow('backdate staff');
    await expect(
      completeSale(
        db,
        sale(
          {
            ...cart,
            reissue: { sale_id: 'old', void_id: 'void', reason: 'Wrong' },
          },
          [{ method: 'cash', amount: 350000 }],
        ),
        await ledgerContext(db, 'st-1'),
        NOW,
      ),
    ).rejects.toBeInstanceOf(SaleInvalidError);
  });
});

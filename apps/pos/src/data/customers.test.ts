import { afterEach, describe, expect, it } from 'vitest';
import {
  createCustomer,
  customerBalance,
  DuplicatePhoneError,
  findCustomers,
} from './customers.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

describe('customers for the cart', () => {
  it('creates with the default credit limit, refuses a duplicate phone, finds by name or phone', async () => {
    const db = await readyDb('cust');
    await addShop(db, { default_credit_limit: 500000 });
    const bilal = await createCustomer(
      db,
      { name: ' Bilal Ahmed ', phone: '+923001112233' },
      'st-1',
      NOW,
    );
    expect(bilal).toMatchObject({
      name: 'Bilal Ahmed',
      credit_limit: 500000,
      updated_by: 'st-1',
    });
    expect((await db.outbox.toArray()).map((o) => o.tbl)).toEqual([
      'customers',
    ]);
    await expect(
      createCustomer(db, { name: 'X', phone: '+923001112233' }, null),
    ).rejects.toBeInstanceOf(DuplicatePhoneError);
    await expect(
      createCustomer(db, { name: '  ', phone: null }, null),
    ).rejects.toThrow(RangeError);
    const sara = await createCustomer(
      db,
      { name: 'Sara', phone: null },
      null,
      NOW,
    );
    expect(sara.credit_limit).toBe(500000);
    await db.party_balances.put({
      party_type: 'customer',
      party_id: sara.id,
      balance: 589000,
      last_activity_at: NOW,
      oldest_unpaid_at: NOW,
    });
    expect(
      (await findCustomers(db, '')).map((h) => [h.customer.name, h.balance]),
    ).toEqual([
      ['Sara', 589000],
      ['Bilal Ahmed', 0],
    ]);
    expect(
      (await findCustomers(db, 'bilal ah')).map((h) => h.customer.id),
    ).toEqual([bilal.id]);
    expect(
      (await findCustomers(db, '0300 111')).map((h) => h.customer.id),
    ).toEqual([bilal.id]);
    expect(await customerBalance(db, sara.id)).toBe(589000);
    expect(await customerBalance(db, 'nobody')).toBe(0);
  });

  it('no shop row means no credit limit; another shop sees none of these customers', async () => {
    const a = await readyDb('custA');
    const b = await readyDb('custB');
    const c = await createCustomer(a, { name: 'Bilal', phone: null }, null);
    expect(c.credit_limit).toBeNull();
    expect(await findCustomers(b, '')).toEqual([]);
  });
});

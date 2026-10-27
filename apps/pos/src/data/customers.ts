import type { BikriDb, MasterRow } from '@bikri/db';
import { writeAction } from './write.ts';

export type CustomerHit = { customer: MasterRow; balance: number };

export class DuplicatePhoneError extends Error {
  readonly ownerName: string;
  constructor(ownerName: string) {
    super(`Phone already belongs to ${ownerName}`);
    this.name = 'DuplicatePhoneError';
    this.ownerName = ownerName;
  }
}

/** Balance the customer owes the shop (> 0), from the party_balances cache. */
export async function customerBalance(
  db: BikriDb,
  id: string,
): Promise<number> {
  const row = await db.party_balances.get(['customer', id]);
  return row?.balance ?? 0;
}

/** Customers by name words or phone digits (leading 0 ignored), most recently active first. */
export async function findCustomers(
  db: BikriDb,
  query: string,
  limit = 20,
): Promise<CustomerHit[]> {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/gu, '').replace(/^0+/u, '');
  const balances = new Map(
    (
      await db.party_balances
        .where('[party_type+party_id]')
        .between(['customer', ''], ['customer', '\uffff'])
        .toArray()
    ).map((b) => [b.party_id, b]),
  );
  const hits: CustomerHit[] = [];
  for (const c of await db.customers.toArray()) {
    if (c.deleted_at) continue;
    const name = String(c.name ?? '').toLowerCase();
    const phone = String(c.phone ?? '').replace(/\D/gu, '');
    const byName = q !== '' && q.split(/\s+/u).every((w) => name.includes(w));
    const byPhone = digits.length >= 3 && phone.includes(digits);
    if (q === '' || byName || byPhone)
      hits.push({ customer: c, balance: balances.get(c.id)?.balance ?? 0 });
  }
  hits.sort(
    (a, b) =>
      (balances.get(b.customer.id)?.last_activity_at ?? 0) -
        (balances.get(a.customer.id)?.last_activity_at ?? 0) ||
      String(a.customer.name).localeCompare(String(b.customer.name)),
  );
  return hits.slice(0, limit);
}

/** New customer (cashiers may create, `party.edit`); the shop's default credit limit applies. */
export async function createCustomer(
  db: BikriDb,
  input: { name: string; phone: string | null },
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new RangeError('name is required');
  const phone = input.phone ?? '';
  if (phone) {
    const same = (
      await db.customers.where('phone').equals(phone).toArray()
    ).find((c) => !c.deleted_at);
    if (same) throw new DuplicatePhoneError(String(same.name));
  }
  const shop = await db.shop.get('shop');
  const limit = shop?.default_credit_limit;
  return writeAction(
    db,
    (w) =>
      w.create('customers', {
        name,
        phone,
        address: '',
        note: '',
        credit_limit: typeof limit === 'number' ? limit : null,
        hard_limit: 0,
      }),
    { now, actor },
  );
}

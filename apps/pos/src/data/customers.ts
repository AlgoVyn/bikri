import { businessDate, newId } from '@bikri/core';
import type { BikriDb, MasterRow } from '@bikri/db';
import type { LedgerContext } from './products.ts';
import { writeAction } from './write.ts';

export type CustomerHit = { customer: MasterRow; balance: number };

export type CustomerInput = {
  name: string;
  phone?: string | null;
  address?: string;
  note?: string;
  credit_limit?: number | null;
  hard_limit?: boolean;
};

export class DuplicatePhoneError extends Error {
  readonly ownerName: string;
  readonly ownerId: string;
  constructor(ownerName: string, ownerId: string) {
    super(`Phone already belongs to ${ownerName}`);
    this.name = 'DuplicatePhoneError';
    this.ownerName = ownerName;
    this.ownerId = ownerId;
  }
}

export class CustomerBalanceError extends Error {
  constructor() {
    super('Customer has a balance');
    this.name = 'CustomerBalanceError';
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

async function assertPhoneFree(
  db: BikriDb,
  phone: string,
  excludeId?: string,
): Promise<void> {
  if (!phone) return;
  const same = (await db.customers.where('phone').equals(phone).toArray()).find(
    (c) => !c.deleted_at && c.id !== excludeId,
  );
  if (same) throw new DuplicatePhoneError(String(same.name), same.id);
}

function clean(input: CustomerInput) {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new RangeError('name is required');
  const limit = input.credit_limit ?? null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
    throw new RangeError('credit limit must be a non-negative amount');
  return {
    name,
    phone: input.phone ?? '',
    address: (input.address ?? '').trim().slice(0, 120),
    note: (input.note ?? '').trim().slice(0, 200),
    credit_limit: limit,
    hard_limit: input.hard_limit ? 1 : 0,
  };
}

/** New customer (cashiers may create, `party.edit`); the shop's default credit limit applies. */
export async function createCustomer(
  db: BikriDb,
  input: CustomerInput,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const fields = clean({
    ...input,
    credit_limit:
      input.credit_limit === undefined
        ? await defaultLimit(db)
        : input.credit_limit,
  });
  await assertPhoneFree(db, fields.phone);
  return writeAction(db, (w) => w.create('customers', fields), {
    now,
    actor,
  });
}

async function defaultLimit(db: BikriDb): Promise<number | null> {
  const shop = await db.shop.get('shop');
  const limit = shop?.default_credit_limit;
  return typeof limit === 'number' ? limit : null;
}

/** New customer with an optional opening balance (screens/12 new customer). */
export async function createCustomerAccount(
  db: BikriDb,
  input: CustomerInput & { opening?: number },
  ctx: LedgerContext,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const opening = input.opening ?? 0;
  if (!Number.isSafeInteger(opening) || opening < 0)
    throw new RangeError('opening balance must be a non-negative amount');
  const fields = clean({
    ...input,
    credit_limit:
      input.credit_limit === undefined
        ? await defaultLimit(db)
        : input.credit_limit,
  });
  await assertPhoneFree(db, fields.phone);
  return writeAction(
    db,
    async (w) => {
      const row = await w.create('customers', fields);
      if (opening > 0) {
        await w.insert('ledger_entries', {
          id: newId(now),
          party_type: 'customer',
          party_id: row.id,
          amount: opening,
          source_type: 'opening',
          source_id: null,
          note: '',
          branch_id: ctx.branch_id,
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          business_date: businessDate(now, ctx.timeZone),
          created_at: now,
        });
      }
      return row;
    },
    { now, actor },
  );
}

/** Edits a customer; a changed credit limit writes `credit_limit_change` (screens/12). */
export async function updateCustomer(
  db: BikriDb,
  id: string,
  input: CustomerInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<MasterRow> {
  const current = await db.customers.get(id);
  if (!current || current.deleted_at)
    throw new RangeError('customer not found');
  const fields = clean({
    ...input,
    credit_limit: input.credit_limit ?? null,
  });
  await assertPhoneFree(db, fields.phone, id);
  return writeAction(
    db,
    async (w) => {
      const row = await w.update('customers', id, fields);
      if (
        Number(current.credit_limit ?? -1) !== Number(fields.credit_limit ?? -1)
      ) {
        await w.insert('audit_log', {
          id: newId(now),
          action: 'credit_limit_change',
          entity: 'customers',
          entity_id: id,
          before_json: JSON.stringify({
            credit_limit: current.credit_limit ?? null,
          }),
          after_json: JSON.stringify({ credit_limit: fields.credit_limit }),
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          created_at: now,
        });
      }
      return row;
    },
    { now, actor: ctx.staff_id },
  );
}

/** Soft-deletes a settled customer (`party.delete`, screens/12). */
export async function deleteCustomer(
  db: BikriDb,
  id: string,
  actor: string | null,
  now = Date.now(),
): Promise<void> {
  if ((await customerBalance(db, id)) !== 0) throw new CustomerBalanceError();
  await writeAction(db, (w) => w.remove('customers', id), { now, actor });
}

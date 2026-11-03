import { businessDate, can, type Role } from '@bikri/core';
import type { BikriDb, CartBackdate } from '@bikri/db';
import { isReadOnly } from '../sync/status.ts';
import {
  CART_IDS,
  type CartId,
  CartNotEmptyError,
  emptyCart,
  isEmptyCart,
  loadCarts,
  saveCart,
} from './cart.ts';
import { ReadOnlyError } from './write.ts';

/** How far back an owner may record a sale (screens/10 "Record past sale"). */
export const BACKDATE_DAYS = 30;
export const BACKDATE_REASON_MAX = 120;

export class BackdateError extends Error {
  readonly code: 'date' | 'range' | 'reason' | 'forbidden' | 'staff';
  constructor(code: BackdateError['code']) {
    super(code);
    this.name = 'BackdateError';
    this.code = code;
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

export type StartBackdateInput = {
  /** The unlocked staff member asking; must hold `sale.backdate`. */
  actorId: string;
  /** The business date the missed sale belongs to. */
  date: string;
  /** The cashier/manager who made the sale; kept in reports and the audit row. */
  staffId: string;
  reason: string;
  /** Prefer this tab when it is empty; otherwise the first free tab is used. */
  cartId?: CartId;
  now?: number;
};

/**
 * Opens "Record a past sale": puts the date, attributed staff and reason on an empty cart.
 * Nothing is written to the ledger until the owner takes payment, so Cancel writes nothing.
 * The sale itself is a normal sale on this device; only the business date and the attributed
 * `staff_id` differ (D-173).
 */
export async function startBackdate(
  db: BikriDb,
  input: StartBackdateInput,
): Promise<{ cartId: CartId }> {
  if (await isReadOnly(db)) throw new ReadOnlyError();
  const now = input.now ?? Date.now();
  const shop = await db.shop.get('shop');
  const timeZone = String(shop?.timezone ?? '').trim() || 'Asia/Karachi';
  const today = businessDate(now, timeZone);
  if (!isBusinessDate(input.date)) throw new BackdateError('date');
  if (input.date > today) throw new BackdateError('range');
  if (input.date < addDays(today, -BACKDATE_DAYS))
    throw new BackdateError('range');
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > BACKDATE_REASON_MAX)
    throw new BackdateError('reason');

  const actor = await db.staff.get(input.actorId);
  if (
    actor?.active !== 1 ||
    actor.deleted_at ||
    !can(
      String(actor.role) as Role,
      String(actor.permissions_json ?? '{}'),
      'sale.backdate',
    )
  )
    throw new BackdateError('forbidden');

  const attributed = await db.staff.get(input.staffId);
  if (attributed?.active !== 1 || attributed.deleted_at)
    throw new BackdateError('staff');

  const carts = await loadCarts(db);
  const preferred = input.cartId;
  const cartId =
    (preferred && isEmptyCart(carts[preferred]) ? preferred : null) ??
    CART_IDS.find((id) => isEmptyCart(carts[id]));
  if (!cartId) throw new CartNotEmptyError();

  const backdate: CartBackdate = {
    business_date: input.date,
    staff_id: input.staffId,
    reason,
  };
  await saveCart(db, { ...emptyCart(cartId, now), backdate }, now);
  return { cartId };
}

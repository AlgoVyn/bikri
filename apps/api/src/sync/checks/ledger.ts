/**
 * Ledger checks (07 §5): every balance row must be backed by the document or payment
 * that created it. Split from applyOpsCheck; `integrity.test.ts` covers the paths.
 */
import type { Permission } from '@bikri/core';
import {
  key,
  type Lookups,
  overrideFor,
  partyExists,
  partyUsableAt,
  Reject,
  type StaffRow,
  saleOf,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';
import { sourceInGroup } from './shared.ts';

/** A party row created in this action (opening balances are sent with the new customer/supplier). */
function partyInGroup(
  group: PushOp[],
  tbl: string,
  id: string | null,
): Record<string, unknown> | undefined {
  if (id === null) return undefined;
  return group.find(
    (o) =>
      o.tbl === tbl &&
      (o.kind === 'insert' || o.kind === 'upsert') &&
      (o.kind === 'insert' || (o.base_rev ?? 0) === 0) &&
      o.row?.id === id,
  )?.row;
}

/** Ledger rows must be backed by the document/payment that created them (07 §5). */
export function checkLedgerEntry(
  group: PushOp[],
  row: Record<string, unknown>,
  staff: StaffRow | null | undefined,
  allowed: (permission: Permission) => boolean,
  look: Lookups,
): void {
  const amount = Number(row.amount);
  const source = String(row.source_type);
  const sourceId =
    typeof row.source_id === 'string' && row.source_id.length > 0
      ? row.source_id
      : null;
  if (!Number.isInteger(amount) || amount === 0)
    throw new Reject('CONSTRAINT_FAILED');
  if (!staff) throw new Reject('FORBIDDEN');
  const sourceTable: Record<string, string> = {
    sale: 'sales',
    refund: 'refunds',
    void: 'sale_voids',
    payment: 'payments',
    purchase: 'purchases',
    supplier_return: 'supplier_returns',
  };
  if (source === 'adjustment') {
    if (staff.role === 'cashier') throw new Reject('FORBIDDEN');
    if (
      !partyUsableAt(
        look,
        group,
        row.party_type as 'customer' | 'supplier',
        row.party_id,
        row.created_at,
      )
    )
      throw new Reject('CONSTRAINT_FAILED');
    return;
  }
  if (source === 'opening') {
    if (row.party_type !== 'customer' && row.party_type !== 'supplier')
      throw new Reject('CONSTRAINT_FAILED');
    if (amount < 0) throw new Reject('CONSTRAINT_FAILED');
    const partyTable =
      row.party_type === 'customer' ? 'customers' : 'suppliers';
    if (
      !partyInGroup(group, partyTable, String(row.party_id)) ||
      !partyUsableAt(
        look,
        group,
        row.party_type,
        row.party_id,
        row.created_at,
      ) ||
      // An opening balance belongs to a new party, not an existing one.
      look.current.has(key(partyTable, String(row.party_id)))
    )
      throw new Reject('CONSTRAINT_FAILED');
    return;
  }
  if (!partyExists(look, group, row.party_type, row.party_id))
    throw new Reject('CONSTRAINT_FAILED');
  const table = sourceTable[source];
  if (!table || sourceId === null) throw new Reject('CONSTRAINT_FAILED');
  const src = sourceInGroup(group, table, sourceId);
  if (!src) throw new Reject('CONSTRAINT_FAILED');
  switch (source) {
    case 'sale':
      if (!allowed('sale.create')) throw new Reject('FORBIDDEN');
      if (
        row.party_type !== 'customer' ||
        row.party_id !== src.customer_id ||
        amount !== Number(src.udhaar_amount)
      )
        throw new Reject('CONSTRAINT_FAILED');
      break;
    case 'refund': {
      if (
        !allowed('refund.create') &&
        !overrideFor(group, 'refunds', sourceId, 'refund.create', look.staff)
      )
        throw new Reject('FORBIDDEN');
      const sale = saleOf(look, group, String(src.sale_id));
      if (
        row.party_type !== 'customer' ||
        amount !== -Number(src.udhaar_part ?? 0) ||
        (sale?.customer_id != null && row.party_id !== sale.customer_id)
      )
        throw new Reject('CONSTRAINT_FAILED');
      break;
    }
    case 'void': {
      if (
        !allowed('sale.void') &&
        !overrideFor(group, 'sale_voids', sourceId, 'sale.void', look.staff)
      )
        throw new Reject('FORBIDDEN');
      const sale = saleOf(look, group, String(src.sale_id));
      if (
        row.party_type !== 'customer' ||
        amount >= 0 ||
        !sale ||
        amount !== -Number(sale.udhaar_amount) ||
        row.party_id !== sale.customer_id
      )
        throw new Reject('CONSTRAINT_FAILED');
      break;
    }
    case 'payment': {
      if (!allowed('payment.receive') && !allowed('purchase.create'))
        throw new Reject('FORBIDDEN');
      // Only a standalone customer/supplier payment may move a party balance through
      // its payment row. A sale/refund/void payment has its own documented ledger row
      // (`source_type = sale/refund/void`); accepting a payment-sourced row here would
      // let a forged push mark a bill paid and reduce the khata at the same time.
      if (
        ![
          'customer_payment',
          'supplier_payment',
          'purchase_paid_now',
          'supplier_refund',
        ].includes(String(src.purpose))
      )
        throw new Reject('CONSTRAINT_FAILED');
      if (row.party_type !== src.party_type || row.party_id !== src.party_id)
        throw new Reject('CONSTRAINT_FAILED');
      // Customer/supplier payments reduce the balance; a supplier refund (cash back)
      // increases it by the amount received.
      const expected =
        src.purpose === 'supplier_refund'
          ? Number(src.amount ?? 0)
          : -Number(src.amount ?? 0);
      if (amount !== expected) throw new Reject('CONSTRAINT_FAILED');
      break;
    }
    case 'purchase':
      if (!allowed('purchase.create')) throw new Reject('FORBIDDEN');
      if (
        row.party_type !== 'supplier' ||
        row.party_id !== src.supplier_id ||
        amount !== Number(src.total ?? 0)
      )
        throw new Reject('CONSTRAINT_FAILED');
      break;
    case 'supplier_return':
      if (!allowed('purchase.create')) throw new Reject('FORBIDDEN');
      if (
        row.party_type !== 'supplier' ||
        row.party_id !== src.supplier_id ||
        amount !== -Number(src.total ?? 0)
      )
        throw new Reject('CONSTRAINT_FAILED');
      break;
  }
}

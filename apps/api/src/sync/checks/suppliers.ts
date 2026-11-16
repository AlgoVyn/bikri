/**
 * Supplier delivery and return checks (07 §7): line maths, ledger rows and the
 * matching paid/refund payment. Split from applyOpsCheck.
 */
import { mulDivRound } from '@bikri/core';
import {
  asPayment,
  type Lookups,
  linkedInGroup,
  onePayment,
  partyUsableAt,
  Reject,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';

/**
 * 04 §5 supplier-return rules: line maths, Σ lines = total, line_count, linked purchase lines of the
 * same supplier, and exactly one matching `supplier_refund` payment when money was received.
 */
export function checkSupplierReturn(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const id = String(row.id);
  if (!partyUsableAt(look, group, 'supplier', row.supplier_id, row.created_at))
    throw new Reject('CONSTRAINT_FAILED');
  const lines = linkedInGroup(group, 'supplier_return_lines', 'return_id', id);
  if (lines.length !== Number(row.line_count))
    throw new Reject('CONSTRAINT_FAILED');
  let sum = 0;
  for (const l of lines) {
    const qty = Number(l.qty_milli);
    const credit = Number(l.unit_credit);
    const total = Number(l.line_total);
    if (
      !Number.isSafeInteger(qty) ||
      qty <= 0 ||
      !Number.isSafeInteger(credit) ||
      credit < 0 ||
      !Number.isSafeInteger(total) ||
      total !== mulDivRound(qty, credit, 1000)
    )
      throw new Reject('CONSTRAINT_FAILED');
    sum += total;
    if (typeof l.purchase_line_id === 'string') {
      const pushed = group.find(
        (o) => o.tbl === 'purchase_lines' && o.row?.id === l.purchase_line_id,
      )?.row;
      const supplier = pushed
        ? group.find(
            (o) => o.tbl === 'purchases' && o.row?.id === pushed.purchase_id,
          )?.row?.supplier_id
        : look.purchaseLineSupplier.get(l.purchase_line_id);
      if (supplier !== undefined && supplier !== row.supplier_id)
        throw new Reject('CONSTRAINT_FAILED');
    }
  }
  if (sum !== Number(row.total)) throw new Reject('CONSTRAINT_FAILED');
  const received = Number(row.refund_received ?? 0);
  const returnLedger = linkedInGroup(
    group,
    'ledger_entries',
    'source_id',
    id,
  ).filter((entry) => entry.source_type === 'supplier_return');
  if (Number(row.total) > 0) {
    if (
      returnLedger.length !== 1 ||
      returnLedger[0]?.party_type !== 'supplier' ||
      returnLedger[0]?.party_id !== row.supplier_id ||
      Number(returnLedger[0]?.amount) !== -Number(row.total)
    )
      throw new Reject('CONSTRAINT_FAILED');
  } else if (returnLedger.length > 0) {
    throw new Reject('CONSTRAINT_FAILED');
  }
  const pays = [
    ...linkedInGroup(group, 'payments', 'supplier_return_id', id).map(
      asPayment,
    ),
    ...(look.linkedPayments.get(`sret:${id}`) ?? []),
  ];
  if (
    received > 0
      ? !onePayment(pays, 'in', 'supplier_refund', row.refund_method, received)
      : pays.length > 0
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (received > 0) {
    const paymentId = group.find(
      (candidate) =>
        candidate.tbl === 'payments' &&
        candidate.kind === 'insert' &&
        candidate.row?.supplier_return_id === id,
    )?.row?.id;
    const refundLedger =
      typeof paymentId !== 'string'
        ? []
        : linkedInGroup(group, 'ledger_entries', 'source_id', paymentId).filter(
            (entry) =>
              entry.source_type === 'payment' &&
              entry.party_type === 'supplier' &&
              entry.party_id === row.supplier_id &&
              Number(entry.amount) === received,
          );
    if (refundLedger.length !== 1) throw new Reject('CONSTRAINT_FAILED');
  }
}

/** Deliveries are reconciled with their lines, charges and paid-now payment (07 §7). */
export function checkPurchase(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const id = String(row.id);
  if (!partyUsableAt(look, group, 'supplier', row.supplier_id, row.created_at))
    throw new Reject('CONSTRAINT_FAILED');
  const lines = linkedInGroup(group, 'purchase_lines', 'purchase_id', id);
  if (lines.length === 0 || lines.length !== Number(row.line_count))
    throw new Reject('CONSTRAINT_FAILED');
  let total = 0;
  let charges = 0;
  for (const line of lines) {
    const qty = Number(line.qty_milli);
    const unit = Number(line.unit_cost);
    const lineTotal = Number(line.line_total);
    const alloc = Number(line.charges_alloc ?? 0);
    const landed = Number(line.landed_unit_cost);
    if (
      !Number.isSafeInteger(qty) ||
      qty <= 0 ||
      !Number.isSafeInteger(unit) ||
      unit < 0 ||
      !Number.isSafeInteger(lineTotal) ||
      !Number.isSafeInteger(alloc) ||
      alloc < 0 ||
      !Number.isSafeInteger(landed) ||
      lineTotal !== mulDivRound(qty, unit, 1000) ||
      landed !== mulDivRound(lineTotal + alloc, 1000, qty)
    )
      throw new Reject('CONSTRAINT_FAILED');
    total += lineTotal;
    charges += alloc;
  }
  if (
    total + Number(row.other_charges ?? 0) !== Number(row.total) ||
    charges !== Number(row.other_charges ?? 0)
  )
    throw new Reject('CONSTRAINT_FAILED');
  const ledger = linkedInGroup(group, 'ledger_entries', 'source_id', id).filter(
    (entry) => entry.source_type === 'purchase',
  );
  if (Number(row.total) > 0) {
    if (
      ledger.length !== 1 ||
      ledger[0]?.party_type !== 'supplier' ||
      ledger[0]?.party_id !== row.supplier_id ||
      Number(ledger[0]?.amount) !== Number(row.total)
    )
      throw new Reject('CONSTRAINT_FAILED');
  } else if (ledger.length > 0) {
    throw new Reject('CONSTRAINT_FAILED');
  }
  const paid = Number(row.paid_now ?? 0);
  const pays = [
    ...linkedInGroup(group, 'payments', 'purchase_id', id).map(asPayment),
    ...(look.linkedPayments.get(`purchase:${id}`) ?? []),
  ];
  if (
    paid > 0
      ? !onePayment(pays, 'out', 'purchase_paid_now', row.paid_method, paid)
      : pays.length > 0
  )
    throw new Reject('CONSTRAINT_FAILED');
  // The cash paid now must also reduce the supplier balance in the same transaction;
  // otherwise payables reports overstate what the shop still owes.
  if (paid > 0) {
    const payment = group.find(
      (candidate) =>
        candidate.tbl === 'payments' &&
        candidate.kind === 'insert' &&
        candidate.row?.purchase_id === id &&
        candidate.row?.purpose === 'purchase_paid_now',
    )?.row;
    const paymentId = typeof payment?.id === 'string' ? payment.id : '';
    const paymentLedger =
      paymentId === ''
        ? []
        : linkedInGroup(group, 'ledger_entries', 'source_id', paymentId).filter(
            (entry) =>
              entry.source_type === 'payment' &&
              entry.party_type === 'supplier' &&
              entry.party_id === row.supplier_id &&
              Number(entry.amount) === -paid,
          );
    if (paymentLedger.length !== 1) throw new Reject('CONSTRAINT_FAILED');
  }
}

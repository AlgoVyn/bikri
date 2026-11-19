/**
 * Refund and void checks (04 §5, 07 §6): split from applyOpsCheck so the money-reversal
 * rules have one home. Called by `checkOp`; `integrity.test.ts` covers both paths.
 */
import { roundTo } from '@bikri/core';
import {
  asPayment,
  type LinkedLedger,
  type Lookups,
  linkedInGroup,
  onePayment,
  Reject,
  saleOf,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';

/**
 * 04 §5 refund rules: the udhaar part fits the sale's remaining udhaar and needs a customer; a paid
 * part has exactly one matching `payments` row and an udhaar part exactly one customer ledger row,
 * in this transaction or already stored. An amount above what was paid is accepted (over_refund).
 */
export function checkRefund(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const id = String(row.id);
  const saleId = String(row.sale_id);
  const sale = saleOf(look, group, saleId);
  const udhaar = Number(row.udhaar_part ?? 0);
  const amount = Number(row.amount ?? 0);
  const lines = linkedInGroup(group, 'refund_lines', 'refund_id', id);
  if (
    lines.length === 0 ||
    lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0) !==
      Number(row.exact_amount ?? 0)
  )
    throw new Reject('CONSTRAINT_FAILED');
  const saleLineInfo = (id: string) => {
    const pushed = group.find(
      (candidate) =>
        candidate.tbl === 'sale_lines' &&
        candidate.kind === 'insert' &&
        candidate.row?.id === id,
    )?.row;
    return pushed ?? look.saleLineById.get(id);
  };
  for (const line of lines) {
    const pushedLine = group.find(
      (candidate) =>
        candidate.tbl === 'sale_lines' &&
        candidate.row?.id === line.sale_line_id,
    )?.row?.sale_id;
    const lineSale =
      look.saleLineSale.get(String(line.sale_line_id)) ??
      (typeof pushedLine === 'string' ? pushedLine : undefined);
    if (lineSale !== undefined && lineSale !== saleId)
      throw new Reject('CONSTRAINT_FAILED');
  }
  // Whole-bundle refunds (07 §6.2): a bundle group is atomic and every component
  // line moves by the same `k` whole bundles.
  const allSaleLines = new Map<
    string,
    {
      id: string;
      bundle_group?: unknown;
      bundle_component_qty_milli?: unknown;
    }
  >();
  for (const line of look.saleLinesBySale.get(saleId) ?? [])
    allSaleLines.set(String(line.id), line);
  for (const candidate of group) {
    if (
      candidate.tbl === 'sale_lines' &&
      candidate.kind === 'insert' &&
      candidate.row?.sale_id === saleId &&
      typeof candidate.row.id === 'string'
    )
      allSaleLines.set(candidate.row.id, {
        id: candidate.row.id,
        bundle_group: candidate.row.bundle_group,
        bundle_component_qty_milli: candidate.row.bundle_component_qty_milli,
      });
  }
  // One refund line per sale line. Duplicate rows used to overwrite each other in this
  // map, so 500 + 1000 on a 1000-per-bundle component passed the whole-bundle check
  // while refunding 1.5 bundles. Reject the document instead of guessing.
  const refundQty = new Map<string, number>();
  for (const line of lines) {
    const saleLineId = String(line.sale_line_id);
    if (refundQty.has(saleLineId)) throw new Reject('CONSTRAINT_FAILED');
    refundQty.set(saleLineId, Number(line.qty_milli ?? 0));
  }
  const bundleGroups = new Map<string, string[]>();
  for (const [id, line] of allSaleLines) {
    if (typeof line.bundle_group !== 'string') continue;
    bundleGroups.set(line.bundle_group, [
      ...(bundleGroups.get(line.bundle_group) ?? []),
      id,
    ]);
  }
  for (const componentIds of bundleGroups.values()) {
    const touched = componentIds.some((id) => (refundQty.get(id) ?? 0) > 0);
    if (!touched) continue;
    let bundles: number | null = null;
    for (const id of componentIds) {
      const line = saleLineInfo(id);
      const perBundle = Number(line?.bundle_component_qty_milli ?? 0);
      const qty = refundQty.get(id) ?? 0;
      if (perBundle <= 0 || qty <= 0 || qty % perBundle !== 0)
        throw new Reject('CONSTRAINT_FAILED');
      const k = qty / perBundle;
      if (bundles === null) bundles = k;
      else if (k !== bundles) throw new Reject('CONSTRAINT_FAILED');
    }
  }
  if (sale && udhaar > 0) {
    if (!sale.customer_id) throw new Reject('CONSTRAINT_FAILED');
    const earlier =
      (look.refundUdhaar.get(saleId) ?? 0) +
      (look.pushedRefundBefore.get(id) ?? 0);
    if (udhaar > sale.udhaar_amount - Math.max(0, earlier))
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (sale) {
    const exact = Number(row.exact_amount ?? 0);
    const paidExact = exact - udhaar;
    const priorAmount =
      (look.refundAmount.get(saleId) ?? 0) +
      (look.pushedRefundAmountBefore.get(id) ?? 0);
    const remainingPaid = Math.max(sale.paid_total - priorAmount, 0);
    // A normal refund cannot invent a rounding amount; an amount above what is left
    // is the documented over-refund path and is accepted (and flagged) instead.
    if (paidExact >= 0 && amount <= remainingPaid) {
      const rounding = Number(row.rounding ?? 0);
      const method = row.method;
      if (paidExact === 0) {
        if (amount !== 0 || rounding !== 0 || method != null)
          throw new Reject('CONSTRAINT_FAILED');
      } else if (method === 'cash') {
        const allowed = new Set([
          paidExact,
          roundTo(paidExact, 100),
          paidExact - (paidExact % 100),
        ]);
        if (paidExact > remainingPaid) allowed.add(remainingPaid);
        if (!allowed.has(amount) || rounding !== amount - paidExact)
          throw new Reject('CONSTRAINT_FAILED');
      } else if (method === 'card' || method === 'bank_wallet') {
        const expected = Math.min(paidExact, remainingPaid);
        if (amount !== expected || rounding !== amount - paidExact)
          throw new Reject('CONSTRAINT_FAILED');
      } else throw new Reject('CONSTRAINT_FAILED');
    }
  }
  const pays = [
    ...linkedInGroup(group, 'payments', 'refund_id', id).map(asPayment),
    ...(look.linkedPayments.get(`refund:${id}`) ?? []),
  ];
  if (
    amount > 0
      ? !onePayment(pays, 'out', 'refund', row.method, amount)
      : pays.length > 0
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (udhaar > 0) {
    const entries: LinkedLedger[] = [
      ...linkedInGroup(group, 'ledger_entries', 'source_id', id)
        .filter((e) => e.source_type === 'refund')
        .map((e) => ({
          party_type: String(e.party_type),
          party_id: String(e.party_id),
          amount: Number(e.amount),
        })),
      ...(look.linkedLedger.get(id) ?? []),
    ];
    const [e] = entries;
    if (
      entries.length !== 1 ||
      !e ||
      e.party_type !== 'customer' ||
      e.amount !== -udhaar ||
      (sale?.customer_id != null && e.party_id !== sale.customer_id)
    )
      throw new Reject('CONSTRAINT_FAILED');
  }
}

/** A void must reverse exactly what the stored sale took: paid money and khata. */
export function checkVoid(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const id = String(row.id);
  const saleId = String(row.sale_id);
  const sale = saleOf(look, group, saleId);
  if (!sale) throw new Reject('CONSTRAINT_FAILED');
  const replacementId = row.replacement_sale_id;
  if (replacementId !== null && replacementId !== undefined) {
    if (
      typeof replacementId !== 'string' ||
      replacementId.length === 0 ||
      replacementId === saleId
    )
      throw new Reject('CONSTRAINT_FAILED');
    const replacement = group.find(
      (candidate) =>
        candidate.tbl === 'sales' &&
        candidate.kind === 'insert' &&
        candidate.row?.id === replacementId,
    )?.row;
    if (!replacement || replacement.replaces_sale_id !== saleId)
      throw new Reject('CONSTRAINT_FAILED');
  }
  const pays = [
    ...linkedInGroup(group, 'payments', 'sale_id', saleId)
      .filter((p) => p.purpose === 'void' && p.direction === 'out')
      .map(asPayment),
    ...(look.linkedPayments.get(`sale:${saleId}`) ?? []).filter(
      (p) => p.purpose === 'void' && p.direction === 'out',
    ),
  ];
  if (sale.paid_total > 0) {
    const reversed = pays.reduce((sum, payment) => sum + payment.amount, 0);
    if (pays.length === 0 || reversed !== sale.paid_total)
      throw new Reject('CONSTRAINT_FAILED');
  } else if (pays.length > 0) {
    throw new Reject('CONSTRAINT_FAILED');
  }
  const entries = linkedInGroup(group, 'ledger_entries', 'source_id', id)
    .filter((e) => e.source_type === 'void')
    .map((e) => ({
      party_type: String(e.party_type),
      party_id: String(e.party_id),
      amount: Number(e.amount),
    }));
  if (sale.udhaar_amount > 0) {
    const [entry] = entries;
    if (
      entries.length !== 1 ||
      !entry ||
      entry.party_type !== 'customer' ||
      entry.amount !== -sale.udhaar_amount ||
      entry.party_id !== sale.customer_id
    )
      throw new Reject('CONSTRAINT_FAILED');
  } else if (entries.length > 0) {
    throw new Reject('CONSTRAINT_FAILED');
  }
}

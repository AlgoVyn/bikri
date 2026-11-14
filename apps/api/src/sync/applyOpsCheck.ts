/**
 * Server write-rule checks for `/sync/push` (`checkOp` and table-family helpers).
 * Behaviour is unchanged from the previous monolithic applyOps.ts.
 */
import {
  allocate,
  allocateRounding,
  businessDate,
  can,
  isBelowCost,
  isLedgerTable,
  isMasterTable,
  isPinVerifierValid,
  isTimeZone,
  mulDivRound,
  type Permission,
  roundTo,
} from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import {
  type ApplyContext,
  asPayment,
  assertOwnerRemains,
  bootstrapOwnerId,
  CLIENT_AUDIT_ACTIONS,
  type CostState,
  DAY_MS,
  isBusinessDate,
  key,
  type LinkedLedger,
  type Lookups,
  linkedInGroup,
  MAX_ROW_OP_SKEW_MS,
  onePayment,
  overrideFor,
  overrideForLine,
  partyExists,
  partyUsableAt,
  Reject,
  removesOwner,
  type StaffRow,
  saleOf,
  staffForHistory,
  staffOf,
} from './applyOpsShared.ts';
import type { PushOp } from './opSchema.ts';
import { columnsOf } from './tables.ts';

/**
 * 04 §5 refund rules: the udhaar part fits the sale's remaining udhaar and needs a customer; a paid
 * part has exactly one matching `payments` row and an udhaar part exactly one customer ledger row,
 * in this transaction or already stored. An amount above what was paid is accepted (over_refund).
 */
function checkRefund(
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
function checkVoid(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const id = String(row.id);
  const saleId = String(row.sale_id);
  const sale = saleOf(look, group, saleId);
  if (!sale) throw new Reject('CONSTRAINT_FAILED');
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

/**
 * 04 §5 supplier-return rules: line maths, Σ lines = total, line_count, linked purchase lines of the
 * same supplier, and exactly one matching `supplier_refund` payment when money was received.
 */
function checkSupplierReturn(
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

/** Server-side checks beyond the database constraints (04 §5, 05 §5). Throws Reject. */
function sourceInGroup(
  group: PushOp[],
  tbl: string,
  id: string | null,
): Record<string, unknown> | undefined {
  if (id === null) return undefined;
  return group.find(
    (o) => o.tbl === tbl && o.kind === 'insert' && o.row?.id === id,
  )?.row;
}

/** The void row id for a sale in this action (override audits are keyed by the void). */
function voidIdForSale(group: PushOp[], saleId: string): string {
  const row = group.find(
    (o) =>
      o.tbl === 'sale_voids' &&
      o.kind === 'insert' &&
      o.row?.sale_id === saleId,
  )?.row;
  return row && typeof row.id === 'string' ? row.id : saleId;
}

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

const ADJUST_REASONS = new Set([
  'count',
  'entry_fix',
  'damaged',
  'expired',
  'lost',
  'spoiled',
  'customer_return',
  'wrong_item',
  'received_godown',
  'received_local',
  'received_other',
  'transfer_in',
  'transfer_out',
]);

/** Ledger rows must be backed by the document/payment that created them (07 §5). */
function checkLedgerEntry(
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

/** Stock adjustments/counts need stock.adjust; source movements need their document. */
function checkStockMovement(
  group: PushOp[],
  row: Record<string, unknown>,
  allowed: (permission: Permission) => boolean,
  look: Lookups,
): void {
  const reason = String(row.reason_code);
  const qty = Number(row.qty_delta_milli);
  if (!Number.isInteger(qty) || qty === 0)
    throw new Reject('CONSTRAINT_FAILED');
  const positive = new Set([
    'opening',
    'purchase',
    'received_godown',
    'received_local',
    'received_other',
    'customer_return',
    'refund_return',
    'void_return',
    'transfer_in',
  ]);
  const negative = new Set([
    'sale',
    'supplier_return',
    'damaged',
    'expired',
    'lost',
    'spoiled',
    'wrong_item',
    'transfer_out',
  ]);
  if ((positive.has(reason) && qty < 0) || (negative.has(reason) && qty > 0))
    throw new Reject('CONSTRAINT_FAILED');
  if (
    [
      'opening',
      'purchase',
      'received_godown',
      'received_local',
      'received_other',
    ].includes(reason) &&
    (!Number.isSafeInteger(row.unit_cost) || Number(row.unit_cost) < 0)
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (ADJUST_REASONS.has(reason) && !allowed('stock.adjust'))
    throw new Reject('FORBIDDEN');
  if (reason === 'opening' && !allowed('catalog.edit'))
    throw new Reject('FORBIDDEN');
  if (
    (reason === 'purchase' || reason === 'supplier_return') &&
    !allowed('purchase.create')
  )
    throw new Reject('FORBIDDEN');
  if (reason === 'sale' && !allowed('sale.create'))
    throw new Reject('FORBIDDEN');
  if (
    reason === 'refund_return' &&
    !allowed('refund.create') &&
    !overrideFor(
      group,
      'refunds',
      typeof row.ref_id === 'string' ? row.ref_id : '',
      'refund.create',
      look.staff,
    )
  )
    throw new Reject('FORBIDDEN');
  if (
    reason === 'void_return' &&
    !allowed('sale.void') &&
    !overrideFor(
      group,
      'sale_voids',
      typeof row.ref_id === 'string' ? row.ref_id : '',
      'sale.void',
      look.staff,
    )
  )
    throw new Reject('FORBIDDEN');
  const sourceTable: Record<string, string> = {
    sale: 'sales',
    refund_return: 'refunds',
    void_return: 'sale_voids',
    purchase: 'purchases',
    supplier_return: 'supplier_returns',
  };
  const table = sourceTable[reason];
  if (
    table !== undefined &&
    (typeof row.ref_id !== 'string' || !sourceInGroup(group, table, row.ref_id))
  )
    throw new Reject('CONSTRAINT_FAILED');
  // A source movement must move the document's own goods, not an arbitrary product.
  const movementsFor = (refId: string, productId: string) =>
    group.filter(
      (candidate) =>
        candidate.tbl === 'stock_movements' &&
        candidate.kind === 'insert' &&
        candidate.row?.reason_code === reason &&
        candidate.row?.ref_id === refId &&
        candidate.row?.product_id === productId,
    );
  if (reason === 'sale' && typeof row.ref_id === 'string') {
    const ref = row.ref_id;
    const productId = String(row.product_id);
    const sold = linkedInGroup(group, 'sale_lines', 'sale_id', ref)
      .filter((line) => line.product_id === productId)
      .reduce((sum, line) => sum + Number(line.qty_milli ?? 0), 0);
    const moved = movementsFor(ref, productId).reduce(
      (sum, movement) => sum - Number(movement.row?.qty_delta_milli ?? 0),
      0,
    );
    if (qty >= 0 || sold <= 0 || moved > sold)
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (reason === 'purchase' && typeof row.ref_id === 'string') {
    const ref = row.ref_id;
    const productId = String(row.product_id);
    const purchaseLines = linkedInGroup(
      group,
      'purchase_lines',
      'purchase_id',
      ref,
    ).filter((line) => line.product_id === productId);
    const received = purchaseLines.reduce(
      (sum, line) => sum + Number(line.qty_milli ?? 0),
      0,
    );
    const moved = movementsFor(ref, productId).reduce(
      (sum, movement) => sum + Number(movement.row?.qty_delta_milli ?? 0),
      0,
    );
    // The server recomputes avg cost from this unit_cost; it must be one of the
    // delivery line landed costs, not an arbitrary cheaper number.
    const landedCosts = new Set(
      purchaseLines.map((line) => Number(line.landed_unit_cost)),
    );
    if (
      qty <= 0 ||
      received <= 0 ||
      moved > received ||
      !landedCosts.has(Number(row.unit_cost))
    )
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (reason === 'supplier_return' && typeof row.ref_id === 'string') {
    const ref = row.ref_id;
    const productId = String(row.product_id);
    const returned = linkedInGroup(
      group,
      'supplier_return_lines',
      'return_id',
      ref,
    )
      .filter((line) => line.product_id === productId)
      .reduce((sum, line) => sum + Number(line.qty_milli ?? 0), 0);
    const moved = movementsFor(ref, productId).reduce(
      (sum, movement) => sum - Number(movement.row?.qty_delta_milli ?? 0),
      0,
    );
    if (qty >= 0 || returned <= 0 || moved > returned)
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (reason === 'refund_return' && typeof row.ref_id === 'string') {
    const ref = row.ref_id;
    const productId = String(row.product_id);
    const refundLines = linkedInGroup(group, 'refund_lines', 'refund_id', ref);
    let restocked = 0;
    for (const line of refundLines) {
      if (Number(line.restock ?? 1) !== 1) continue;
      const saleLineId = String(line.sale_line_id ?? '');
      const pushed = group.find(
        (candidate) =>
          candidate.tbl === 'sale_lines' &&
          candidate.kind === 'insert' &&
          candidate.row?.id === saleLineId,
      )?.row;
      const stored = look.saleLineById.get(saleLineId);
      if ((pushed?.product_id ?? stored?.product_id) !== productId) continue;
      restocked += Number(line.qty_milli ?? 0);
    }
    const moved = movementsFor(ref, productId).reduce(
      (sum, movement) => sum + Number(movement.row?.qty_delta_milli ?? 0),
      0,
    );
    if (qty <= 0 || restocked <= 0 || moved > restocked)
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (reason === 'void_return' && typeof row.ref_id === 'string') {
    const ref = row.ref_id;
    const productId = String(row.product_id);
    const voidRow = sourceInGroup(group, 'sale_voids', ref);
    const saleId = typeof voidRow?.sale_id === 'string' ? voidRow.sale_id : '';
    const saleLines = [
      ...(look.saleLinesBySale.get(saleId) ?? []),
      ...linkedInGroup(group, 'sale_lines', 'sale_id', saleId),
    ];
    const sold = saleLines
      .filter((line) => line.product_id === productId)
      .reduce((sum, line) => sum + Number(line.qty_milli ?? 0), 0);
    const moved = movementsFor(ref, productId).reduce(
      (sum, movement) => sum + Number(movement.row?.qty_delta_milli ?? 0),
      0,
    );
    if (qty <= 0 || sold <= 0 || moved > sold)
      throw new Reject('CONSTRAINT_FAILED');
  }
}

/** Deliveries are reconciled with their lines, charges and paid-now payment (07 §7). */
function checkPurchase(
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
/** Sales are reconciled with their lines, payments and udhaar ledger row (07 §2). */
function checkSaleInsert(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const n = (value: unknown) => Number(value ?? 0);
  const lines = linkedInGroup(group, 'sale_lines', 'sale_id', String(row.id));
  if (lines.length === 0) throw new Reject('CONSTRAINT_FAILED');
  if (n(row.line_count) !== lines.length) throw new Reject('CONSTRAINT_FAILED');
  if (
    lines.reduce((sum, line) => sum + n(line.qty_milli), 0) !==
    n(row.items_qty_milli)
  )
    throw new Reject('CONSTRAINT_FAILED');
  for (const line of lines) {
    for (const field of ['gross', 'discount', 'net'] as const) {
      if (n(line[field]) < 0) throw new Reject('CONSTRAINT_FAILED');
    }
    if (n(line.qty_milli) <= 0 || n(line.unit_price) < 0)
      throw new Reject('CONSTRAINT_FAILED');
  }
  const sum = (field: string) =>
    lines.reduce((total, line) => total + n(line[field]), 0);
  if (sum('gross') !== n(row.gross_total))
    throw new Reject('CONSTRAINT_FAILED');
  if (sum('discount') !== n(row.item_discount_total))
    throw new Reject('CONSTRAINT_FAILED');
  if (sum('net') !== n(row.subtotal)) throw new Reject('CONSTRAINT_FAILED');
  for (const field of [
    'total',
    'paid_total',
    'udhaar_amount',
    'tax',
    'bill_discount',
  ] as const) {
    if (n(row[field]) < 0) throw new Reject('CONSTRAINT_FAILED');
  }
  if (n(row.tax_rate_bp) < 0) throw new Reject('CONSTRAINT_FAILED');
  if (
    row.customer_id !== null &&
    row.customer_id !== undefined &&
    !partyUsableAt(look, group, 'customer', row.customer_id, row.created_at)
  )
    throw new Reject('CONSTRAINT_FAILED');

  const payments = group.filter(
    (candidate) =>
      candidate.tbl === 'payments' &&
      candidate.kind === 'insert' &&
      candidate.row?.sale_id === row.id &&
      candidate.row?.purpose === 'sale' &&
      candidate.row?.direction === 'in',
  );
  const paid = payments.reduce(
    (total, candidate) => total + n(candidate.row?.amount),
    0,
  );
  if (paid !== n(row.paid_total)) throw new Reject('CONSTRAINT_FAILED');
  // Cash is the only method that may exceed what is due; the difference is change
  // (07 §4). Validate the drawer arithmetic instead of trusting the sale row.
  let cashApplied = 0;
  for (const payment of payments) {
    const method = String(payment.row?.method);
    const amount = n(payment.row?.amount);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Reject('CONSTRAINT_FAILED');
    if (method === 'cash') {
      cashApplied += amount;
      if (
        n(payment.row?.cash_tendered) !== n(row.cash_tendered) ||
        n(payment.row?.change_given) !== n(row.change_given)
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else if (method === 'card' || method === 'bank_wallet') {
      if (
        payment.row?.cash_tendered !== null ||
        payment.row?.change_given !== null
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else throw new Reject('CONSTRAINT_FAILED');
  }
  const tendered = n(row.cash_tendered);
  const change = n(row.change_given);
  if (
    !Number.isSafeInteger(tendered) ||
    !Number.isSafeInteger(change) ||
    tendered < cashApplied ||
    change !== tendered - cashApplied ||
    (cashApplied === 0 && (tendered !== 0 || change !== 0))
  )
    throw new Reject('CONSTRAINT_FAILED');

  const udhaar = n(row.udhaar_amount);
  const ledger = group.filter(
    (candidate) =>
      candidate.tbl === 'ledger_entries' &&
      candidate.kind === 'insert' &&
      candidate.row?.source_type === 'sale' &&
      candidate.row?.source_id === row.id,
  );
  if (udhaar > 0) {
    if (ledger.length !== 1 || n(ledger[0]?.row?.amount) !== udhaar)
      throw new Reject('CONSTRAINT_FAILED');
  } else if (ledger.length !== 0) {
    throw new Reject('CONSTRAINT_FAILED');
  }
}

/** Recompute price/tax/discount policy instead of trusting the client totals. */
function checkSalePolicy(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
  staff: StaffRow | null,
  allowed: (permission: Permission) => boolean,
  entryAt: number,
  costs: Map<string, CostState>,
  deviceSeenAt: number,
): void {
  const n = (value: unknown) => Number(value ?? 0);
  if (!allowed('sale.create')) throw new Reject('FORBIDDEN');
  const saleId = String(row.id);
  const lines = linkedInGroup(group, 'sale_lines', 'sale_id', saleId).sort(
    (a, b) =>
      // Allocations were computed in cart order (newest line first); `completeSale`
      // writes the bill oldest-first, so line_no descending is that cart order.
      Number(b.line_no) - Number(a.line_no) ||
      String(b.id).localeCompare(String(a.id)),
  );
  const taxRate = n(row.tax_rate_bp);
  const inclusive = Number(row.tax_inclusive) === 1;
  // A shop setting only governs sales made after it changed; an offline sale keeps the
  // snapshot it was rung with. The envelope time, not the client-authored row time, is
  // the authority for "when it was rung".
  const fresh = look.shop !== null && entryAt >= look.shop.updated_at;
  if (fresh && look.shop && taxRate !== look.shop.tax_rate_bp)
    throw new Reject('CONSTRAINT_FAILED');
  if (fresh && look.shop && inclusive !== (look.shop.tax_mode === 'inclusive'))
    throw new Reject('CONSTRAINT_FAILED');

  const subtotal = n(row.subtotal);
  const billType = row.bill_discount_type;
  const billValue = n(row.bill_discount_value);
  const bill = n(row.bill_discount);
  if (billType === null || billType === undefined) {
    if (bill !== 0 || billValue !== 0) throw new Reject('CONSTRAINT_FAILED');
  } else if (billType === 'rs') {
    if (
      !Number.isSafeInteger(billValue) ||
      billValue < 0 ||
      bill !== Math.min(billValue, subtotal)
    )
      throw new Reject('CONSTRAINT_FAILED');
  } else if (billType === 'pct') {
    if (
      !Number.isSafeInteger(billValue) ||
      billValue < 0 ||
      bill !== mulDivRound(subtotal, Math.min(billValue, 10_000), 10_000)
    )
      throw new Reject('CONSTRAINT_FAILED');
  } else throw new Reject('CONSTRAINT_FAILED');

  const taxable = subtotal - bill;
  const expectedTax =
    taxRate === 0
      ? 0
      : inclusive
        ? taxable - mulDivRound(taxable, 10_000, 10_000 + taxRate)
        : mulDivRound(taxable, taxRate, 10_000);
  if (expectedTax !== n(row.tax)) throw new Reject('CONSTRAINT_FAILED');
  const preRound = inclusive ? taxable : taxable + expectedTax;
  const rounding = n(row.rounding);
  if (fresh && look.shop) {
    const expectedRounding =
      roundTo(preRound, look.shop.round_total_to) - preRound;
    if (rounding !== expectedRounding) throw new Reject('CONSTRAINT_FAILED');
  }
  if (n(row.total) !== preRound + rounding)
    throw new Reject('CONSTRAINT_FAILED');
  // Even an offline sale must have rounded to one of the shop-schema steps; the exact
  // step is only knowable for sales rung after the last settings change.
  if (
    ![1, 100, 500, 1000].some(
      (step) => n(row.total) === roundTo(preRound, step),
    )
  )
    throw new Reject('CONSTRAINT_FAILED');

  // Reproduce the per-line allocations (07 §3) so a client cannot move money between
  // lines to fake a below-cost flag or a tax share.
  const nets = lines.map((line) => n(line.net));
  const billAlloc = allocate(bill, nets);
  const taxAlloc = allocate(expectedTax, nets);
  const bases = nets.map((net, index) =>
    inclusive
      ? net - (billAlloc[index] as number)
      : net - (billAlloc[index] as number) + (taxAlloc[index] as number),
  );
  let roundAlloc = allocate(rounding, nets);
  if (bases.some((base, index) => base + (roundAlloc[index] as number) < 0))
    roundAlloc = allocateRounding(rounding, bases);

  let belowCost = false;
  for (const [index, line] of lines.entries()) {
    const qty = n(line.qty_milli);
    const unitPrice = n(line.unit_price);
    const gross = mulDivRound(qty, unitPrice, 1000);
    if (gross !== n(line.gross)) throw new Reject('CONSTRAINT_FAILED');
    const discountType = line.discount_type;
    const discountValue = n(line.discount_value);
    let expectedDiscount = 0;
    if (discountType === null || discountType === undefined) {
      if (discountValue !== 0) throw new Reject('CONSTRAINT_FAILED');
    } else if (discountType === 'rs') {
      if (!Number.isSafeInteger(discountValue) || discountValue < 0)
        throw new Reject('CONSTRAINT_FAILED');
      expectedDiscount = Math.min(discountValue, gross);
    } else if (discountType === 'pct') {
      if (!Number.isSafeInteger(discountValue) || discountValue < 0)
        throw new Reject('CONSTRAINT_FAILED');
      expectedDiscount = mulDivRound(
        gross,
        Math.min(discountValue, 10_000),
        10_000,
      );
    } else throw new Reject('CONSTRAINT_FAILED');
    if (n(line.discount) !== expectedDiscount)
      throw new Reject('CONSTRAINT_FAILED');
    if (n(line.net) !== gross - expectedDiscount)
      throw new Reject('CONSTRAINT_FAILED');
    const lineBill = billAlloc[index] as number;
    const lineTax = taxAlloc[index] as number;
    const lineRounding = roundAlloc[index] as number;
    if (
      n(line.bill_discount_alloc) !== lineBill ||
      n(line.tax_alloc) !== lineTax ||
      n(line.rounding_alloc) !== lineRounding
    )
      throw new Reject('CONSTRAINT_FAILED');
    const unitCost = n(line.unit_cost_snapshot);
    if (!Number.isSafeInteger(unitCost) || unitCost < 0)
      throw new Reject('CONSTRAINT_FAILED');
    const lineCreatedAt = n(line.created_at);
    if (Math.abs(lineCreatedAt - entryAt) > MAX_ROW_OP_SKEW_MS)
      throw new Reject('CONSTRAINT_FAILED');
    const product =
      typeof line.product_id === 'string'
        ? look.products.get(line.product_id)
        : undefined;
    const costState =
      typeof line.product_id === 'string'
        ? costs.get(line.product_id)
        : undefined;
    const costChangedAt = costState?.cost_changed_at ?? 0;
    // A cost change after this sale, or one this device could not have pulled yet, makes
    // the snapshot the authoritative historical value. Same-push costed movements are
    // deterministic from the pushed rows, so they are always checked.
    const costKnown =
      costState?.pushed === true ||
      costChangedAt === 0 ||
      (entryAt >= costChangedAt && costChangedAt <= deviceSeenAt);
    const shopKnown =
      !look.shop ||
      (entryAt >= look.shop.updated_at && look.shop.updated_at <= deviceSeenAt);
    if ((product || costState) && costKnown && shopKnown) {
      const expectedCost =
        (look.shop?.cost_method ?? 'avg') === 'last'
          ? (costState?.last_cost ?? product?.last_cost ?? 0)
          : (costState?.avg_cost ?? product?.avg_cost ?? 0);
      if (unitCost !== expectedCost) throw new Reject('CONSTRAINT_FAILED');
    }
    if (product && entryAt >= product.updated_at) {
      if (
        unitPrice < product.price &&
        !allowed('catalog.edit') &&
        !overrideForLine(
          look,
          group,
          'sales',
          saleId,
          String(line.id),
          unitPrice,
        )
      )
        throw new Reject('FORBIDDEN');
    }
    const revenue = n(line.net) - lineBill - (inclusive ? lineTax : 0);
    const below = isBelowCost(revenue, qty, unitCost);
    if (n(line.below_cost) !== (below ? 1 : 0))
      throw new Reject('CONSTRAINT_FAILED');
    belowCost ||= below;
  }
  const sum = (field: string) =>
    lines.reduce((total, line) => total + n(line[field]), 0);
  if (
    sum('bill_discount_alloc') !== bill ||
    sum('tax_alloc') !== expectedTax ||
    sum('rounding_alloc') !== rounding
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (
    belowCost &&
    !allowed('sale.below_cost') &&
    !overrideFor(group, 'sales', saleId, 'sale.below_cost', look.staff)
  )
    throw new Reject('FORBIDDEN');

  const discount = n(row.item_discount_total) + bill;
  if (discount > 0) {
    if (!allowed('sale.discount')) throw new Reject('FORBIDDEN');
    const share =
      n(row.gross_total) === 0
        ? 0
        : mulDivRound(discount, 10_000, n(row.gross_total));
    const maxBp = staff?.max_discount_bp ?? 0;
    // The limit governs the sale when it was rung, not a later staff edit.
    const limitFresh = !staff || entryAt >= staff.updated_at;
    if (
      limitFresh &&
      share > maxBp &&
      !overrideFor(
        group,
        'sales',
        saleId,
        'sale.discount',
        look.staff,
        ['owner', 'manager'],
        { excludeStaffId: staff?.id, minDiscountBp: share },
      )
    )
      throw new Reject('FORBIDDEN');
  }
  if (n(row.udhaar_amount) > 0 && !allowed('sale.udhaar'))
    throw new Reject('FORBIDDEN');
}

/**
 * A sale recorded on a past business date (D-173/D-174): the till must send a
 * `sale_backdated` audit row in the same transaction, written by a staff member with
 * `sale.backdate` (owner by default). A genuine offline sale carries an op `created_at`
 * on its own business date, so it never enters this path. Any past date is accepted
 * (D-174); only a future business date is rejected.
 */
function checkBackdatedSale(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
  opCreatedAt: number,
  now: number,
): void {
  const tz = look.shop?.timezone || 'Asia/Karachi';
  const opDate = businessDate(opCreatedAt, tz);
  const business = String(row.business_date ?? '');
  // The server's current business date is the only trustworthy upper bound.
  if (business > businessDate(now, tz)) throw new Reject('CONSTRAINT_FAILED');
  if (business === opDate) return;
  if (business > opDate) throw new Reject('CONSTRAINT_FAILED');
  const audit = group.find(
    (candidate) =>
      candidate.tbl === 'audit_log' &&
      candidate.kind === 'insert' &&
      candidate.row?.action === 'sale_backdated' &&
      candidate.row?.entity === 'sales' &&
      candidate.row?.entity_id === row.id,
  )?.row;
  if (!audit) throw new Reject('FORBIDDEN');
  const recorder = staffForHistory(
    look,
    group,
    audit.staff_id,
    Number(audit.created_at),
  );
  if (
    !recorder ||
    !can(recorder.role, recorder.permissions_json, 'sale.backdate')
  )
    throw new Reject('FORBIDDEN');
  let after: {
    attributed_staff_id?: unknown;
    business_date?: unknown;
    reason?: unknown;
  };
  try {
    after = JSON.parse(String(audit.after_json ?? '{}')) as typeof after;
  } catch {
    throw new Reject('CONSTRAINT_FAILED');
  }
  const reason = typeof after.reason === 'string' ? after.reason.trim() : '';
  if (
    after.attributed_staff_id !== row.staff_id ||
    after.business_date !== business ||
    reason.length === 0 ||
    reason.length > 120
  )
    throw new Reject('CONSTRAINT_FAILED');
}

export function checkOp(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  costs: Map<string, CostState>,
): void {
  if (!isMasterTable(op.tbl) && !isLedgerTable(op.tbl))
    throw new Reject('UNKNOWN_TABLE');
  if (isLedgerTable(op.tbl) && op.kind !== 'insert')
    throw new Reject('IMMUTABLE_TABLE');
  if (isMasterTable(op.tbl) && op.kind === 'insert')
    throw new Reject('CONSTRAINT_FAILED');
  if (op.tbl === 'staff' && removesOwner(look, op))
    assertOwnerRemains(look, group);
  if (op.kind === 'delete') {
    if (!op.row_id) throw new Reject('CONSTRAINT_FAILED');
    if (['staff', 'branches', 'shop'].includes(op.tbl)) {
      if (staffOf(look, group, op.updated_by)?.role !== 'owner')
        throw new Reject('FORBIDDEN');
    }
    const need: Partial<Record<string, Permission>> = {
      products: 'catalog.delete',
      product_barcodes: 'catalog.edit',
      categories: 'catalog.edit',
      expense_categories: 'settings.shop',
      promises: 'party.edit',
      customers: 'party.delete',
      suppliers: 'party.delete',
    };
    const perm = need[op.tbl];
    if (perm) {
      const s = staffOf(look, group, op.updated_by);
      if (!s || !can(s.role, s.permissions_json, perm))
        throw new Reject('FORBIDDEN');
    }
    if (op.row_id && (op.tbl === 'customers' || op.tbl === 'suppliers')) {
      const type = op.tbl === 'customers' ? 'customer' : 'supplier';
      const balance =
        (look.partyBalances.get(key(type, op.row_id)) ?? 0) +
        group
          .filter(
            (candidate) =>
              candidate.kind === 'insert' &&
              candidate.tbl === 'ledger_entries' &&
              candidate.row?.party_type === type &&
              candidate.row?.party_id === op.row_id,
          )
          .reduce(
            (sum, candidate) => sum + Number(candidate.row?.amount ?? 0),
            0,
          );
      if (balance !== 0) throw new Reject('CONSTRAINT_FAILED');
    }
    return;
  }
  const row = op.row;
  if (!row || typeof row.id !== 'string' || row.id.length === 0)
    throw new Reject('CONSTRAINT_FAILED');
  if (typeof row.created_at === 'number' && row.created_at > ctx.now + DAY_MS)
    throw new Reject('CONSTRAINT_FAILED');
  if ('business_date' in row && !isBusinessDate(row.business_date))
    throw new Reject('CONSTRAINT_FAILED');
  if (op.tbl === 'promises' && !isBusinessDate(row.promised_on))
    throw new Reject('CONSTRAINT_FAILED');
  for (const field of ['created_at', 'updated_at', 'deleted_at'] as const) {
    if (!(field in row) || row[field] === null) continue;
    if (typeof row[field] !== 'number' || !Number.isSafeInteger(row[field]))
      throw new Reject('CONSTRAINT_FAILED');
    // A future updated_at would make every later sale look older than the row and
    // silently disable the price/tax/limit freshness checks.
    if (field !== 'created_at' && (row[field] as number) > ctx.now + DAY_MS)
      throw new Reject('CONSTRAINT_FAILED');
  }
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === 'string' && value.length > 4_000)
      throw new Reject('CONSTRAINT_FAILED');
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new Reject('CONSTRAINT_FAILED');
    if (value !== null && typeof value === 'object')
      throw new Reject('CONSTRAINT_FAILED');
    if (column === 'id' && typeof value !== 'string')
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (
    typeof op.created_at === 'number' &&
    (op.created_at > ctx.now + DAY_MS ||
      op.created_at < ctx.tenant.created_at - DAY_MS)
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (op.kind === 'insert') {
    // A restore-recovery replay (fresh op id) or an op older than the applied_ops
    // retention window targets a row D1 already has. It cannot change anything, so
    // skip the document checks that count stored companion rows; planOp marks it
    // `existingInsert` and the group-level check rejects a mixed replay.
    if (look.existingLedger.has(key(op.tbl, String(row.id)))) return;
    const rowCreatedAt =
      typeof row.created_at === 'number' ? row.created_at : null;
    if (
      typeof op.created_at === 'number' &&
      rowCreatedAt !== null &&
      Math.abs(rowCreatedAt - op.created_at) > MAX_ROW_OP_SKEW_MS
    )
      throw new Reject('CONSTRAINT_FAILED');
    const cols = new Set(columnsOf(op.tbl as D1Table));
    if (cols.has('device_id') && row.device_id !== ctx.device.id)
      throw new Reject('FORBIDDEN');
    const staff = staffForHistory(
      look,
      group,
      row.staff_id,
      Number(row.created_at),
    );
    if (cols.has('staff_id') && !staff) throw new Reject('FORBIDDEN');
    const allowed = (p: Permission) =>
      Boolean(staff && can(staff.role, staff.permissions_json, p));
    switch (op.tbl) {
      case 'sales': {
        // The prefix may come from an earlier bill_prefix setting, and the device code
        // from before a branch move; UNIQUE(tenant_id, invoice_no) is the collision guard.
        const invoice = /^[A-Z0-9]{1,6}-([A-Z]{1,3})-(\d+)$/u.exec(
          String(row.invoice_no),
        );
        const codes = new Set([
          ctx.device.device_code,
          ...String(ctx.device.device_code_history ?? '')
            .split(',')
            .filter(Boolean),
        ]);
        const branch = look.branches.get(String(row.branch_id));
        if (!branch) throw new Reject('CONSTRAINT_FAILED');
        // A till that was offline during a branch move still has to deliver the sales it
        // rang on the old branch. The invoice code (current or historical) proves the
        // device wrote the bill; rejecting these would strand real money.
        if (
          !invoice ||
          !codes.has(invoice[1] ?? '') ||
          !Number.isSafeInteger(Number(row.invoice_seq)) ||
          Number(row.invoice_seq) <= 0 ||
          Number(invoice[2]) !== Number(row.invoice_seq)
        )
          throw new Reject('CONSTRAINT_FAILED');
        if (
          row.tax_rate_bp !== undefined &&
          (!Number.isSafeInteger(Number(row.tax_rate_bp)) ||
            Number(row.tax_rate_bp) < 0 ||
            Number(row.tax_rate_bp) > 5_000)
        )
          throw new Reject('CONSTRAINT_FAILED');
        checkSaleInsert(look, group, row);
        // Older clients and imported files may omit the envelope timestamp. The sale's
        // own created_at is the entry time; never let a missing op.created_at skip the
        // backdate audit check.
        const entryAt =
          typeof op.created_at === 'number'
            ? op.created_at
            : Number(row.created_at);
        if (!Number.isSafeInteger(entryAt))
          throw new Reject('CONSTRAINT_FAILED');
        try {
          checkSalePolicy(
            look,
            group,
            row,
            staff,
            allowed,
            entryAt,
            costs,
            Number(ctx.device.last_seen_at ?? 0),
          );
          checkBackdatedSale(look, group, row, entryAt, ctx.now);
        } catch (error) {
          // Money helpers throw RangeError on malformed arithmetic; that is a bad row,
          // not an internal failure, so the op is rejected instead of retried forever.
          if (error instanceof RangeError)
            throw new Reject('CONSTRAINT_FAILED');
          throw error;
        }
        break;
      }
      case 'ledger_entries':
        checkLedgerEntry(group, row, staff, allowed, look);
        break;
      case 'stock_movements':
        checkStockMovement(group, row, allowed, look);
        break;
      case 'refunds':
        if (
          !allowed('refund.create') &&
          !overrideFor(group, 'refunds', row.id, 'refund.create', look.staff)
        )
          throw new Reject('FORBIDDEN');
        checkRefund(look, group, row);
        break;
      case 'refund_lines':
        if (
          !sourceInGroup(
            group,
            'refunds',
            typeof row.refund_id === 'string' ? row.refund_id : '',
          )
        )
          throw new Reject('CONSTRAINT_FAILED');
        break;
      case 'supplier_return_lines': {
        if (
          !sourceInGroup(
            group,
            'supplier_returns',
            typeof row.return_id === 'string' ? row.return_id : '',
          )
        )
          throw new Reject('CONSTRAINT_FAILED');
        const qty = Number(row.qty_milli);
        const credit = Number(row.unit_credit);
        const lineTotal = Number(row.line_total);
        if (
          !Number.isSafeInteger(qty) ||
          qty <= 0 ||
          !Number.isSafeInteger(credit) ||
          credit < 0 ||
          !Number.isSafeInteger(lineTotal) ||
          lineTotal !== mulDivRound(qty, credit, 1000)
        )
          throw new Reject('CONSTRAINT_FAILED');
        break;
      }
      case 'sale_voids': {
        const over = overrideFor(
          group,
          'sale_voids',
          row.id,
          'sale.void',
          look.staff,
        );
        if (!allowed('sale.void') && !over) throw new Reject('FORBIDDEN');
        // 05 §5: a manager voids only bills of the same business day (D-044).
        if (staff?.role === 'manager' && !over) {
          const saleId = String(row.sale_id);
          const saleDate = saleOf(look, group, saleId)?.business_date;
          if (saleDate !== undefined && saleDate !== row.business_date)
            throw new Reject('FORBIDDEN');
        }
        checkVoid(look, group, row);
        break;
      }
      case 'sale_lines': {
        if (
          !sourceInGroup(
            group,
            'sales',
            typeof row.sale_id === 'string' ? row.sale_id : '',
          )
        )
          throw new Reject('CONSTRAINT_FAILED');
        if (row.below_cost === 1) {
          const sale = group.find(
            (o) => o.tbl === 'sales' && o.row?.id === row.sale_id,
          )?.row;
          const seller = staffForHistory(
            look,
            group,
            sale?.staff_id,
            sale?.created_at,
          );
          const ok =
            (seller &&
              can(seller.role, seller.permissions_json, 'sale.below_cost')) ||
            overrideFor(
              group,
              'sales',
              String(row.sale_id),
              'sale.below_cost',
              look.staff,
            );
          if (!ok) throw new Reject('FORBIDDEN');
        }
        break;
      }
      case 'expenses': {
        if (Number(row.amount) === 0) throw new Reject('CONSTRAINT_FAILED');
        const over = overrideFor(
          group,
          'expenses',
          row.id,
          'expense.create',
          look.staff,
          ['owner', 'manager'],
        );
        if (!allowed('expense.create') && !over) throw new Reject('FORBIDDEN');
        if (typeof row.reverses_id === 'string') {
          const originalId = row.reverses_id;
          const inGroup = group.find(
            (candidate) =>
              candidate.tbl === 'expenses' &&
              candidate.kind !== 'delete' &&
              candidate.row?.id === originalId,
          )?.row;
          const original = look.expenses.get(originalId) ?? inGroup;
          if (!original || original.reverses_id)
            throw new Reject('CONSTRAINT_FAILED');
          if (
            Number(row.amount) !== Number(original.amount) ||
            row.method !== original.method ||
            row.business_date !==
              String(
                (original as { business_date?: unknown }).business_date ?? '',
              )
          )
            throw new Reject('CONSTRAINT_FAILED');
          // A cashier may reverse only a same-day expense (D-117); the client enforces
          // this, but the server must not trust that.
          if (
            staff?.role === 'cashier' &&
            !over &&
            String(
              (original as { business_date?: unknown }).business_date ?? '',
            ) !== businessDate(ctx.now, look.shop?.timezone || 'Asia/Karachi')
          )
            throw new Reject('FORBIDDEN');
          const duplicate =
            look.existingReversals.has(originalId) ||
            group.some(
              (candidate) =>
                candidate !== op &&
                candidate.tbl === 'expenses' &&
                candidate.kind === 'insert' &&
                candidate.row?.reverses_id === originalId,
            );
          if (duplicate) throw new Reject('CONSTRAINT_FAILED');
        } else if (staff?.role === 'cashier' && !over) {
          if (row.method !== 'cash' || Number(row.amount) > 200_000)
            throw new Reject('FORBIDDEN');
        }
        break;
      }
      case 'supplier_returns':
        if (!allowed('purchase.create')) throw new Reject('FORBIDDEN');
        checkSupplierReturn(look, group, row);
        break;
      case 'purchases':
        if (!allowed('purchase.create')) throw new Reject('FORBIDDEN');
        if (Number(row.total) < 0 || Number(row.other_charges) < 0)
          throw new Reject('CONSTRAINT_FAILED');
        checkPurchase(look, group, row);
        break;
      case 'purchase_lines': {
        if (
          !sourceInGroup(
            group,
            'purchases',
            typeof row.purchase_id === 'string' ? row.purchase_id : '',
          )
        )
          throw new Reject('CONSTRAINT_FAILED');
        const qty = Number(row.qty_milli);
        const unit = Number(row.unit_cost);
        const lineTotal = Number(row.line_total);
        const alloc = Number(row.charges_alloc ?? 0);
        const landed = Number(row.landed_unit_cost);
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
        break;
      }
      case 'cash_moves':
        if (!allowed('cash.move')) throw new Reject('FORBIDDEN');
        break;
      case 'payments': {
        if (Number(row.amount) <= 0) throw new Reject('CONSTRAINT_FAILED');
        if (!['in', 'out'].includes(String(row.direction)))
          throw new Reject('CONSTRAINT_FAILED');
        if (!['cash', 'card', 'bank_wallet'].includes(String(row.method)))
          throw new Reject('CONSTRAINT_FAILED');
        const purpose = String(row.purpose);
        const expectedDirection: Record<string, 'in' | 'out'> = {
          sale: 'in',
          refund: 'out',
          void: 'out',
          customer_payment: 'in',
          supplier_payment: 'out',
          purchase_paid_now: 'out',
          supplier_refund: 'in',
        };
        if (
          expectedDirection[purpose] !== undefined &&
          row.direction !== expectedDirection[purpose]
        )
          throw new Reject('CONSTRAINT_FAILED');
        if (
          (purpose === 'customer_payment' && row.party_type !== 'customer') ||
          ((purpose === 'supplier_payment' || purpose === 'supplier_refund') &&
            row.party_type !== 'supplier')
        )
          throw new Reject('CONSTRAINT_FAILED');
        if (
          row.party_type !== null &&
          row.party_type !== undefined &&
          !partyUsableAt(
            look,
            group,
            row.party_type as 'customer' | 'supplier',
            row.party_id,
            row.created_at,
          )
        )
          throw new Reject('CONSTRAINT_FAILED');
        const ok =
          purpose === 'supplier_payment' ||
          purpose === 'purchase_paid_now' ||
          purpose === 'supplier_refund'
            ? allowed('purchase.create')
            : purpose === 'customer_payment'
              ? allowed('payment.receive')
              : purpose === 'sale'
                ? allowed('sale.create')
                : purpose === 'refund'
                  ? allowed('refund.create') ||
                    overrideFor(
                      group,
                      'refunds',
                      String(row.refund_id),
                      'refund.create',
                      look.staff,
                    )
                  : purpose === 'void'
                    ? allowed('sale.void') ||
                      overrideFor(
                        group,
                        'sale_voids',
                        voidIdForSale(group, String(row.sale_id)),
                        'sale.void',
                        look.staff,
                      )
                    : true;
        if (!ok) throw new Reject('FORBIDDEN');
        const documentFor: Record<string, [string, unknown]> = {
          sale: ['sales', row.sale_id],
          refund: ['refunds', row.refund_id],
          purchase_paid_now: ['purchases', row.purchase_id],
          supplier_refund: ['supplier_returns', row.supplier_return_id],
        };
        const document = documentFor[purpose];
        if (
          document &&
          (typeof document[1] !== 'string' ||
            !sourceInGroup(group, document[0], document[1]))
        )
          throw new Reject('CONSTRAINT_FAILED');
        if (purpose === 'void') {
          const saleId = typeof row.sale_id === 'string' ? row.sale_id : '';
          const voidRow = group.find(
            (candidate) =>
              candidate.tbl === 'sale_voids' &&
              candidate.kind === 'insert' &&
              candidate.row?.sale_id === saleId,
          );
          if (row.direction !== 'out' || !voidRow)
            throw new Reject('CONSTRAINT_FAILED');
        }
        if (purpose === 'customer_payment' || purpose === 'supplier_payment') {
          const paymentId = String(row.id);
          const ledger = group.find(
            (candidate) =>
              candidate.tbl === 'ledger_entries' &&
              candidate.kind === 'insert' &&
              candidate.row?.source_type === 'payment' &&
              candidate.row?.source_id === paymentId,
          );
          if (!ledger) throw new Reject('CONSTRAINT_FAILED');
        }
        break;
      }
      case 'day_closes': {
        if (!allowed('dayclose.create')) throw new Reject('FORBIDDEN');
        if (
          Number(row.period_start) > Number(row.period_end) ||
          Number(row.period_end) !== Number(row.created_at)
        )
          throw new Reject('CONSTRAINT_FAILED');
        // A close continues the device's drawer: its period must start where the last
        // one ended and reopen with the cash that was counted. Otherwise expected-cash
        // history can be rewritten by a second close for the same period. Closes
        // replayed together after a restore are chained within the push as well.
        const deviceId = String(row.device_id);
        const closeId = String(row.id);
        const periodEnd = Number(row.period_end);
        const stored = look.lastClose.get(deviceId);
        // A close is a continuation of the device's drawer. An older close must not be
        // inserted after a newer one: it would overlap and its opening float could be
        // fabricated. Restore replays are ordered by the client.
        const outOfOrder =
          stored !== undefined &&
          stored.id !== closeId &&
          stored.period_end >= periodEnd;
        if (outOfOrder) throw new Reject('CONSTRAINT_FAILED');
        const candidates = [
          ...(stored && stored.period_end < periodEnd ? [stored] : []),
          ...(look.pushedCloses.get(deviceId) ?? []).filter(
            (close) => close.id !== closeId && close.period_end < periodEnd,
          ),
        ].sort((a, b) => b.period_end - a.period_end);
        const previous = candidates[0];
        if (
          previous &&
          (Number(row.period_start) !== previous.period_end ||
            Number(row.opening_cash) !== previous.counted_cash)
        )
          throw new Reject('CONSTRAINT_FAILED');
        if (
          (stored &&
            stored.id !== closeId &&
            stored.period_end === periodEnd) ||
          (look.pushedCloses.get(deviceId) ?? []).some(
            (close) => close.id !== closeId && close.period_end === periodEnd,
          )
        )
          throw new Reject('CONSTRAINT_FAILED');
        // Recompute the drawer from the cash rows, including rows in this push (a
        // restore can replay a close and its payments before D1 has them).
        const periodStart = Number(row.period_start);
        const inPeriod = (at: number, device: string) =>
          device === deviceId && at > periodStart && at <= periodEnd;
        let cashSales = 0;
        let udhaarCashIn = 0;
        let supplierCashIn = 0;
        let cashRefunds = 0;
        let supplierCashOut = 0;
        for (const payment of look.closePayments.values()) {
          if (
            payment.method !== 'cash' ||
            !inPeriod(payment.created_at, payment.device_id)
          )
            continue;
          if (payment.direction === 'in') {
            if (payment.purpose === 'sale') cashSales += payment.amount;
            else if (payment.purpose === 'customer_payment')
              udhaarCashIn += payment.amount;
            else if (payment.purpose === 'supplier_refund')
              supplierCashIn += payment.amount;
          } else if (payment.direction === 'out') {
            if (payment.purpose === 'refund' || payment.purpose === 'void')
              cashRefunds += payment.amount;
            else if (
              payment.purpose === 'supplier_payment' ||
              payment.purpose === 'purchase_paid_now'
            )
              supplierCashOut += payment.amount;
          }
        }
        let payIns = 0;
        let payOuts = 0;
        for (const move of look.closeCashMoves.values()) {
          if (!inPeriod(move.created_at, move.device_id)) continue;
          if (move.kind === 'pay_in') payIns += move.amount;
          else if (move.kind === 'pay_out') payOuts += move.amount;
        }
        let cashExpenses = 0;
        for (const expense of look.closeExpenses.values()) {
          if (
            expense.method !== 'cash' ||
            !inPeriod(expense.created_at, expense.device_id)
          )
            continue;
          cashExpenses += expense.amount * (expense.reverses_id ? -1 : 1);
        }
        const opening = Number(row.opening_cash);
        const expected =
          opening +
          cashSales +
          udhaarCashIn +
          payIns +
          supplierCashIn -
          cashRefunds -
          cashExpenses -
          supplierCashOut -
          payOuts;
        const counted = Number(row.counted_cash);
        if (
          Number(row.cash_sales) !== cashSales ||
          Number(row.udhaar_cash_in) !== udhaarCashIn ||
          Number(row.pay_ins) !== payIns ||
          Number(row.supplier_cash_in) !== supplierCashIn ||
          Number(row.cash_refunds) !== cashRefunds ||
          Number(row.cash_expenses) !== cashExpenses ||
          Number(row.supplier_cash_out) !== supplierCashOut ||
          Number(row.pay_outs) !== payOuts ||
          Number(row.expected_cash) !== expected ||
          Number(row.difference) !== counted - expected
        )
          throw new Reject('CONSTRAINT_FAILED');
        break;
      }
      case 'audit_log': {
        if (!CLIENT_AUDIT_ACTIONS.has(String(row.action)))
          throw new Reject('FORBIDDEN');
        if (
          row.action === 'sale_backdated' &&
          (row.entity !== 'sales' || typeof row.entity_id !== 'string')
        )
          throw new Reject('CONSTRAINT_FAILED');
        for (const field of ['before_json', 'after_json']) {
          const value = row[field];
          if (value === null || value === undefined) continue;
          try {
            JSON.parse(String(value));
          } catch {
            throw new Reject('CONSTRAINT_FAILED');
          }
        }
        break;
      }
      default:
        break;
    }
    return;
  }

  // upsert (master)
  const updater = staffOf(look, group, row.updated_by);
  if (op.tbl === 'staff' || op.tbl === 'branches' || op.tbl === 'shop') {
    // The setup wizard creates the first owner together with the shop; every later staff/shop/
    // branch change needs a persisted owner. A group-created owner cannot approve its own row
    // outside that one bootstrap group (05 §5).
    const bootstrap = bootstrapOwnerId(look, group);
    const persisted = updater ? look.staff.get(updater.id) : undefined;
    if (updater?.role !== 'owner' || (!persisted && updater.id !== bootstrap))
      throw new Reject('FORBIDDEN');
  }
  if (op.tbl === 'branches') {
    if (!/^[A-Z0-9]{1,6}$/u.test(String(row.bill_prefix ?? '')))
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (op.tbl === 'shop') {
    const cur = look.current.get(key('shop', 'shop'));
    if ((op.base_rev ?? 0) === 0 && cur?.setup_completed_at)
      throw new Reject('SETUP_ALREADY_DONE');
    // Completion is a one-way flag. Replaying or editing the shop row must not reopen
    // the setup wizard or reset the timestamp.
    if (
      cur?.setup_completed_at &&
      row.setup_completed_at !== undefined &&
      Number(row.setup_completed_at) !== Number(cur.setup_completed_at)
    )
      throw new Reject('CONSTRAINT_FAILED');
  }
  // A value the op will actually write (an insert, or an edit that lists the field).
  // `planOp` writes only `changed_fields` for an existing master row.
  const writesColumn = (tbl: string, id: string, field: string): boolean =>
    !look.current.has(key(tbl, id)) ||
    (op.changed_fields ?? []).includes(field);
  if (
    op.tbl === 'shop' &&
    row.timezone !== undefined &&
    writesColumn('shop', 'shop', 'timezone') &&
    !isTimeZone(row.timezone)
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (op.tbl === 'staff') {
    const pinFields = ['pin_hash', 'pin_salt', 'pin_iterations', 'pin_length'];
    if (
      pinFields.some((field) => writesColumn('staff', String(row.id), field))
    ) {
      if (
        typeof row.pin_hash !== 'string' ||
        typeof row.pin_salt !== 'string' ||
        !isPinVerifierValid({
          pin_hash: row.pin_hash,
          pin_salt: row.pin_salt,
          pin_iterations: row.pin_iterations,
        })
      )
        throw new Reject('CONSTRAINT_FAILED');
      if (
        row.pin_length !== undefined &&
        (!Number.isSafeInteger(row.pin_length) ||
          Number(row.pin_length) < 4 ||
          Number(row.pin_length) > 6)
      )
        throw new Reject('CONSTRAINT_FAILED');
    }
  }
  if (
    op.tbl === 'products' ||
    op.tbl === 'categories' ||
    op.tbl === 'product_barcodes'
  ) {
    const catalogueEdit = Boolean(
      updater && can(updater.role, updater.permissions_json, 'catalog.edit'),
    );
    const changes = (op.changed_fields ?? []).filter(
      (field) => field !== 'avg_cost',
    );
    // `avg_cost` is server-managed, so it must not make a costed delivery or stock-in
    // look like a catalogue edit. The companion costed movement/purchase line is the
    // authority for this consequence.
    const costSource =
      op.tbl === 'products' &&
      look.current.has(key('products', row.id)) &&
      changes.every((field) => field === 'last_cost') &&
      group.some(
        (candidate) =>
          candidate.kind === 'insert' &&
          candidate.row?.product_id === row.id &&
          ((candidate.tbl === 'purchase_lines' &&
            typeof candidate.row?.purchase_id === 'string') ||
            (candidate.tbl === 'stock_movements' &&
              [
                'opening',
                'purchase',
                'received_godown',
                'received_local',
                'received_other',
              ].includes(String(candidate.row?.reason_code)))),
      );
    if (!catalogueEdit && !costSource) throw new Reject('FORBIDDEN');
    if (
      op.tbl === 'products' &&
      row.deleted_at != null &&
      (!updater ||
        !can(updater.role, updater.permissions_json, 'catalog.delete'))
    )
      throw new Reject('FORBIDDEN');
  }
  if (op.tbl === 'expense_categories') {
    if (
      !updater ||
      !can(updater.role, updater.permissions_json, 'settings.shop')
    )
      throw new Reject('FORBIDDEN');
  }
  if (op.tbl === 'promises') {
    if (!updater || !can(updater.role, updater.permissions_json, 'party.edit'))
      throw new Reject('FORBIDDEN');
  }
  if (op.tbl === 'customers' || op.tbl === 'suppliers') {
    const partyId = String(row.id);
    if (!updater || !can(updater.role, updater.permissions_json, 'party.edit'))
      throw new Reject('FORBIDDEN');
    // 05 §6: a cashier may create a party, but not edit an existing one or set a limit.
    const isNew = !look.current.has(key(op.tbl, partyId));
    if (updater.role === 'cashier' && !isNew) throw new Reject('FORBIDDEN');
    if (
      updater.role !== 'owner' &&
      row.hard_limit !== undefined &&
      Number(row.hard_limit ?? 0) !== 0
    )
      throw new Reject('FORBIDDEN');
    if (updater.role === 'cashier' && isNew) {
      const defaultLimit = look.shop?.default_credit_limit ?? null;
      if (
        row.credit_limit !== undefined &&
        (row.credit_limit === null
          ? defaultLimit !== null
          : defaultLimit === null ||
            Number(row.credit_limit) !== Number(defaultLimit))
      )
        throw new Reject('FORBIDDEN');
    }
    if (
      row.deleted_at != null &&
      !can(updater.role, updater.permissions_json, 'party.delete')
    )
      throw new Reject('FORBIDDEN');
    if (op.tbl === 'customers' && row.hard_limit !== undefined) {
      const cur = look.current.get(key(op.tbl, partyId));
      // Only an owner may change a hard limit; an unchanged value is fine.
      if (
        updater.role !== 'owner' &&
        cur &&
        cur.deleted_at === null &&
        Number(row.hard_limit ?? 0) !== Number(cur.hard_limit ?? 0)
      )
        throw new Reject('FORBIDDEN');
    }
  }
}

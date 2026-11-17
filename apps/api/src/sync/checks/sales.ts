/**
 * Sale checks (07 §2, §6.2): line/payment identity, price and discount policy, bundle
 * groups and backdated audits. Split from applyOpsCheck; `checkOp` calls them.
 */
import {
  allocate,
  allocateRounding,
  businessDate,
  can,
  isBelowCost,
  mulDivRound,
  type Permission,
  roundTo,
} from '@bikri/core';
import type { Lookups } from '../applyOpsShared.ts';
import {
  type CostState,
  linkedInGroup,
  MAX_ROW_OP_SKEW_MS,
  overrideFor,
  overrideForLine,
  partyUsableAt,
  Reject,
  type StaffRow,
  staffForHistory,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';
import { checkBundleSaleGroups } from './bundles.ts';

/** Sales are reconciled with their lines, payments and udhaar ledger row (07 §2). */
export function checkSaleInsert(
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
export function checkSalePolicy(
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
  checkBundleSaleGroups(
    look,
    group,
    row,
    lines.map((line) => line),
    entryAt,
    deviceSeenAt,
    allowed,
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
    // A bundle is never a sale line of its own; its components carry the bundle_* fields.
    if (
      product &&
      !line.bundle_id &&
      String(product.kind ?? 'simple') === 'bundle'
    )
      throw new Reject('CONSTRAINT_FAILED');
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
    // A bundle component price is derived by priceBundle, not a manual override;
    // the bundle group total is the guard instead.
    if (product && !line.bundle_id && entryAt >= product.updated_at) {
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

  // Bundle residual paisa is an allocation artifact, not a staff discount (07 §3.1).
  // A whole-bundle discount is a real manual discount and counts once per group.
  const bundleResidual = lines.reduce(
    (sum, line) => sum + (line.bundle_id ? n(line.discount) : 0),
    0,
  );
  const bundleGroups = new Set<string>();
  let bundleDiscountTotal = 0;
  for (const line of lines) {
    if (!line.bundle_id || !line.bundle_group) continue;
    const group = String(line.bundle_group);
    if (bundleGroups.has(group)) continue;
    bundleGroups.add(group);
    bundleDiscountTotal += n(line.bundle_discount) * n(line.bundle_qty);
  }
  const discount =
    n(row.item_discount_total) + bill - bundleResidual + bundleDiscountTotal;
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
export function checkBackdatedSale(
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

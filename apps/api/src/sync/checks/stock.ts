/**
 * Stock-movement checks (07 §7): reasons, permissions, source documents and cost
 * repair. Split from applyOpsCheck; the stock/permission tests cover the paths.
 */
import type { Permission } from '@bikri/core';
import {
  type Lookups,
  linkedInGroup,
  overrideFor,
  Reject,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';
import { sourceInGroup } from './shared.ts';

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

/** Stock adjustments/counts need stock.adjust; source movements need their document. */
export function checkStockMovement(
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

/**
 * Server write-rule checks for `/sync/push` (`checkOp` and the structural checks).
 * Domain checks live in `checks/`: refunds/voids, bundles, ledger, stock, suppliers and
 * sales; `checkOp` stays the dispatcher and structural boundary.
 */
import {
  businessDate,
  can,
  isLedgerTable,
  isMasterTable,
  isPinVerifierValid,
  isTimeZone,
  mulDivRound,
  type Permission,
} from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import {
  type ApplyContext,
  assertOwnerRemains,
  bootstrapOwnerId,
  CLIENT_AUDIT_ACTIONS,
  type CostMap,
  DAY_MS,
  isBusinessDate,
  key,
  type Lookups,
  MAX_ROW_OP_SKEW_MS,
  overrideFor,
  partyUsableAt,
  Reject,
  removesOwner,
  saleOf,
  staffForHistory,
  staffOf,
} from './applyOpsShared.ts';
import {
  activeBundleComponents,
  productDeletedInGroup,
} from './checks/bundles.ts';
import { checkLedgerEntry } from './checks/ledger.ts';
import { checkRefund, checkVoid } from './checks/refunds.ts';
import {
  checkBackdatedSale,
  checkSaleInsert,
  checkSalePolicy,
} from './checks/sales.ts';
import { sourceInGroup } from './checks/shared.ts';
import { checkStockMovement } from './checks/stock.ts';
import { checkPurchase, checkSupplierReturn } from './checks/suppliers.ts';
import type { PushOp } from './opSchema.ts';
import { columnsOf } from './tables.ts';

/**
 * Short text columns keep the cap their screen enforces. The structural check below
 * already rejects more than 4 KB, but a sale remark is 120 characters in the UI and
 * prints on the thermal receipt, so the Worker must not accept 4,000 (review L6).
 */
const TEXT_CAPS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  sales: { invoice_no: 64, note: 120 },
  sale_lines: { name_snapshot: 120, sku_snapshot: 64, note: 60 },
  refunds: { reason: 120 },
  refund_lines: { name_snapshot: 120, sku_snapshot: 64, note: 60 },
  payments: { reference: 120, note: 120 },
  products: {
    name_en: 80,
    name_ur: 80,
    brand: 40,
    sku: 40,
    unit: 16,
    notes: 500,
  },
  categories: { name_en: 40, name_ur: 40 },
  customers: { name: 60, phone: 30, address: 120, note: 200 },
  suppliers: { name: 60, phone: 30, address: 120, note: 200 },
  staff: { name: 40 },
  shop: {
    name: 60,
    phone: 30,
    address: 120,
    city: 40,
    ntn: 40,
    strn: 40,
    tax_label: 40,
    receipt_header: 120,
    receipt_footer: 160,
  },
  expenses: { payee: 60, note: 120 },
  stock_movements: { note: 120 },
  day_closes: { note: 200 },
  purchases: { supplier_invoice_no: 30, note: 200 },
  purchase_lines: { name_snapshot: 120, note: 200 },
  supplier_returns: { reason: 120, note: 200 },
  ledger_entries: { note: 200 },
  promises: { note: 120 },
  cash_moves: { reason: 120 },
};

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

export function checkOp(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  costs: CostMap,
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
      bundle_items: 'catalog.edit',
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
    if (op.tbl === 'bundle_items') {
      const rowId = String(op.row_id);
      const pushed = group.find(
        (candidate) =>
          candidate.tbl === 'bundle_items' &&
          candidate.kind !== 'delete' &&
          candidate.row?.id === rowId,
      )?.row;
      const target =
        look.bundleItemById.get(rowId) ??
        (pushed
          ? {
              bundle_id: String(pushed.bundle_id),
              component_product_id: String(pushed.component_product_id),
            }
          : undefined);
      if (!target) return; // a replay of an already-deleted recipe row is a no-op
      const remaining = activeBundleComponents(look, group, target.bundle_id);
      if (
        remaining.size < 1 &&
        !productDeletedInGroup(look, group, target.bundle_id)
      )
        throw new Reject('CONSTRAINT_FAILED');
    }
    if (op.tbl === 'products') {
      for (const bundleId of look.bundleOfComponent.get(String(op.row_id)) ??
        []) {
        if (productDeletedInGroup(look, group, bundleId)) continue;
        if (activeBundleComponents(look, group, bundleId).has(op.row_id))
          throw new Reject('CONSTRAINT_FAILED');
      }
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
    if (typeof value === 'string') {
      const cap = TEXT_CAPS[op.tbl]?.[column] ?? 4_000;
      if (value.length > cap) throw new Reject('CONSTRAINT_FAILED');
    }
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
        // The void's business date is its own event date, not a client-chosen field:
        // a manager must not be able to void a 30-day-old bill by copying that bill's
        // date. It also cannot be in the future.
        const tz = look.shop?.timezone || 'Asia/Karachi';
        const createdAt = Number(row.created_at);
        const voidDate = String(row.business_date);
        if (
          !Number.isSafeInteger(createdAt) ||
          voidDate !== businessDate(createdAt, tz) ||
          voidDate > businessDate(ctx.now, tz)
        )
          throw new Reject('CONSTRAINT_FAILED');
        // 05 §5, D-044: only an owner voids a bill from an earlier business day. Every
        // non-owner (manager, or a cashier with a `sale.void` grant) stays same-day, and
        // only an owner may approve the override — a manager's self-approval is not an
        // owner override (API-H2).
        const saleId = String(row.sale_id);
        const saleDate = saleOf(look, group, saleId)?.business_date;
        if (saleDate !== undefined && saleDate !== voidDate) {
          const ownerOver = overrideFor(
            group,
            'sale_voids',
            row.id,
            'sale.void',
            look.staff,
            ['owner'],
          );
          if (staff?.role !== 'owner' && !ownerOver)
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
        // Older clients omit `business_date` (applyOps fills it from the parent); a
        // supplied value must still be the parent sale's date, never a backdated hop.
        if (row.business_date !== undefined && row.business_date !== null) {
          const parent = saleOf(look, group, String(row.sale_id));
          if (!parent || parent.business_date !== row.business_date)
            throw new Reject('CONSTRAINT_FAILED');
        }
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
          // A cashier may reverse only a same-day expense (D-117, screens/14). Compare
          // the original's business date with the day the reversal was actually made
          // (`created_at`), not with the server's sync time: an offline reversal synced
          // the next morning is still a same-day reversal (API-M1). The reversal date
          // must be the row's own date, so a cashier cannot backdate it to pass.
          if (staff?.role === 'cashier' && !over) {
            const tz = look.shop?.timezone || 'Asia/Karachi';
            const createdAt = Number(row.created_at);
            const reversalDate = Number.isSafeInteger(createdAt)
              ? businessDate(createdAt, tz)
              : '';
            if (
              reversalDate === '' ||
              String(row.business_date) !== reversalDate ||
              reversalDate > businessDate(ctx.now, tz) ||
              String(
                (original as { business_date?: unknown }).business_date ?? '',
              ) !== reversalDate
            )
              throw new Reject('FORBIDDEN');
          }
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
    const changed = new Set(op.changed_fields ?? []);
    if (look.current.has(key('staff', String(row.id)))) {
      // A partial verifier update would pair the new hash with the old salt/iterations.
      const verifier = ['pin_hash', 'pin_salt', 'pin_iterations'];
      const touched = verifier.filter((field) => changed.has(field));
      if (
        (touched.length > 0 && touched.length !== verifier.length) ||
        (changed.has('pin_length') && touched.length !== verifier.length)
      )
        throw new Reject('CONSTRAINT_FAILED');
    }
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
    op.tbl === 'product_barcodes' ||
    op.tbl === 'bundle_items'
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
    const hasCostSource =
      op.tbl === 'products' &&
      look.current.has(key('products', row.id)) &&
      group.some(
        (candidate) =>
          candidate.kind === 'insert' &&
          candidate.row?.product_id === row.id &&
          ((candidate.tbl === 'purchase_lines' &&
            typeof candidate.row?.purchase_id === 'string') ||
            (candidate.tbl === 'stock_movements' &&
              [
                'purchase',
                'received_godown',
                'received_local',
                'received_other',
              ].includes(String(candidate.row?.reason_code)))),
      );
    const onlyCostChange =
      changes.length > 0 && changes.every((field) => field === 'last_cost');
    // A retried `last_cost`-only upsert (its sibling movement was already committed by a
    // lost round) is a no-op when the stored cost already matches, so it cannot smuggle a
    // catalogue change (API-H1).
    const costNoop =
      op.tbl === 'products' &&
      changes.length > 0 &&
      changes.every((field) => field === 'last_cost') &&
      row.last_cost !== undefined &&
      Number(row.last_cost) ===
        Number(look.products.get(String(row.id))?.last_cost);
    // A costed delivery may update `last_cost` without `catalog.edit`; a price change
    // in the same op still needs catalogue permission (POS-H1).
    if (!catalogueEdit && !(onlyCostChange && hasCostSource) && !costNoop)
      throw new Reject('FORBIDDEN');
    if (
      op.tbl === 'products' &&
      changes.includes('last_cost') &&
      row.last_cost !== undefined &&
      !hasCostSource
    ) {
      const current = look.products.get(String(row.id));
      // Use the effective state: `row` is a full local row, but `planOp` writes only
      // `changed_fields`. A `last_cost`-only push carrying `track_stock: 0` must not
      // bypass the tracked-product cost guard (API-M3).
      const effectiveTrackStock = writesColumn(
        'products',
        String(row.id),
        'track_stock',
      )
        ? Number(row.track_stock ?? 0)
        : Number(current?.track_stock ?? 0);
      if (
        current?.track_stock === 1 &&
        effectiveTrackStock !== 0 &&
        Number(row.last_cost) !== current.last_cost
      )
        throw new Reject('CONSTRAINT_FAILED');
    }
    if (
      op.tbl === 'products' &&
      row.deleted_at != null &&
      (!updater ||
        !can(updater.role, updater.permissions_json, 'catalog.delete'))
    )
      throw new Reject('FORBIDDEN');
  }
  if (op.tbl === 'bundle_items') {
    const bundleId = String(row.bundle_id ?? '');
    const componentId = String(row.component_product_id ?? '');
    const qty = Number(row.qty_milli ?? 0);
    const pushed = (id: string) =>
      group.find(
        (candidate) =>
          candidate.tbl === 'products' &&
          candidate.kind !== 'delete' &&
          candidate.row?.id === id,
      )?.row;
    const bundle = pushed(bundleId) ?? look.products.get(bundleId);
    const component = pushed(componentId) ?? look.products.get(componentId);
    if (
      !bundle ||
      String(bundle.kind ?? 'simple') !== 'bundle' ||
      bundle.deleted_at != null ||
      !component ||
      String(component.kind ?? 'simple') === 'bundle' ||
      (component as { deleted_at?: number | null }).deleted_at != null ||
      bundleId === componentId ||
      !Number.isSafeInteger(qty) ||
      qty <= 0
    )
      throw new Reject('CONSTRAINT_FAILED');
    // The recipe after this op and the other recipe ops of the same transaction. A
    // delete has no row payload, so counting rows in `group` used to miss deletions
    // (dead code) and reject a legitimate 20→20 swap (API-H6).
    const components = activeBundleComponents(look, group, bundleId);
    if (
      (components.size < 1 || components.size > 20) &&
      !productDeletedInGroup(look, group, bundleId)
    )
      throw new Reject('CONSTRAINT_FAILED');
  }
  if (op.tbl === 'products') {
    // D-229 invariants are enforced on the state the op actually leaves: `planOp` writes
    // only `changed_fields` for an existing row, so a `track_stock`-only update of a
    // bundle (or a `kind`-only flip with `track_stock` omitted) must not slip through
    // (API-H6).
    const productId = String(row.id);
    const stored = look.current.get(key('products', productId));
    const local = look.products.get(productId);
    const writes = (field: string) =>
      writesColumn('products', productId, field);
    const kind = writes('kind')
      ? String(row.kind ?? 'simple')
      : String(local?.kind ?? 'simple');
    const trackStock = writes('track_stock')
      ? Number(row.track_stock ?? 0)
      : Number(local?.track_stock ?? 0);
    // A soft-deleted row is never resurrected (03 §5), matching planOp's write list.
    const storedDeleted = stored?.deleted_at ?? null;
    const deletedAt =
      storedDeleted !== null
        ? storedDeleted
        : writes('deleted_at')
          ? row.deleted_at
          : null;
    const components = activeBundleComponents(look, group, productId);
    if (kind === 'bundle') {
      if (trackStock !== 0) throw new Reject('CONSTRAINT_FAILED');
      if (deletedAt == null && (components.size < 1 || components.size > 20))
        throw new Reject('CONSTRAINT_FAILED');
    } else if (deletedAt == null && components.size > 0) {
      // An active bundle with a recipe cannot become a simple product.
      throw new Reject('CONSTRAINT_FAILED');
    }
    if (deletedAt != null || kind === 'bundle') {
      // Deleting a component or turning it into a bundle is forbidden while another
      // bundle's recipe uses it. A normal simple-product edit (price, name, last_cost, …)
      // stays allowed so a bundle sale in the same push does not reject it.
      for (const bundleId of look.bundleOfComponent.get(productId) ?? []) {
        if (productDeletedInGroup(look, group, bundleId)) continue;
        if (activeBundleComponents(look, group, bundleId).has(productId))
          throw new Reject('CONSTRAINT_FAILED');
      }
    }
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
    // A soft delete through `upsert` must obey the same zero-balance rule as a
    // `delete` op (05 §6, API-H3).
    const cur = look.current.get(key(op.tbl, partyId));
    if (row.deleted_at != null && cur?.deleted_at == null) {
      const type = op.tbl === 'customers' ? 'customer' : 'supplier';
      const balance =
        (look.partyBalances.get(key(type, partyId)) ?? 0) +
        group
          .filter(
            (candidate) =>
              candidate.kind === 'insert' &&
              candidate.tbl === 'ledger_entries' &&
              candidate.row?.party_type === type &&
              candidate.row?.party_id === partyId,
          )
          .reduce(
            (sum, candidate) => sum + Number(candidate.row?.amount ?? 0),
            0,
          );
      if (balance !== 0) throw new Reject('CONSTRAINT_FAILED');
    }
    if (op.tbl === 'customers' && row.hard_limit !== undefined) {
      // Only an owner may change a hard limit (or set one on a new customer); an
      // unchanged value from the full row payload is fine.
      const changed =
        cur && cur.deleted_at === null
          ? Number(row.hard_limit ?? 0) !== Number(cur.hard_limit ?? 0)
          : Number(row.hard_limit ?? 0) !== 0;
      if (updater.role !== 'owner' && changed) throw new Reject('FORBIDDEN');
    }
  }
}

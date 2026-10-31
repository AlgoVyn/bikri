/**
 * Push algorithm (03 §4.1). Every statement is tenant-scoped through `tenantDb`. Ops are grouped
 * by `tx_id` (one user action); a group is applied or rejected as a whole (D-104).
 */
import {
  can,
  isLedgerTable,
  isMasterTable,
  movementChangesAvgCost,
  mulDivRound,
  newId,
  nextAvgCost,
  type Permission,
  type Role,
} from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import type { SqlValue, TenantDb } from '../db/tenantDb.ts';
import type { DeviceRow, TenantRow } from '../types.ts';
import type { OpResult, PushOp } from './opSchema.ts';
import { applyRank, columnsOf, rowJsonExpr } from './tables.ts';

/** D1 calls one push may make (Free plan: 50 per invocation; 03 §4.1 step 5). */
export const MAX_D1_CALLS = 40;

export class CallBudget {
  used = 0;
  readonly max: number;
  constructor(max = MAX_D1_CALLS) {
    this.max = max;
  }
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
}

export type ApplyContext = {
  db: TenantDb;
  tenant: TenantRow;
  /** The device whose ops these are (the caller, or the revoked device of an import). */
  device: DeviceRow;
  now: number;
  budget: CallBudget;
};

export type ApplyOutcome = {
  results: OpResult[];
  rowsWritten: number;
  rowsRead: number;
  /** Statements the caller runs in its final batch (rejections), with the usage upsert. */
  tail: D1PreparedStatement[];
};

const COLUMN = /^[a-z_][a-z0-9_]*$/u;
const NEVER_FROM_CLIENT = new Set(['tenant_id', 'rev']);

/** Audit actions a till may write; operator/tenant lifecycle rows are server-only. */
const CLIENT_AUDIT_ACTIONS = new Set([
  'branch_change',
  'backup_restore',
  'cache_rebuilt',
  'cost_change',
  'credit_limit_change',
  'day_close_difference',
  'discount_over_limit',
  'drawer_open',
  'override',
  'party_delete',
  'pin_reset',
  'price_change',
  'product_delete',
  'refund',
  'reissue',
  'shop_change',
  'staff_change',
  'stock_count',
  'supplier_return',
  'sync_ops_discarded',
  'void',
]);
const SERVER_MANAGED: Partial<Record<string, ReadonlySet<string>>> = {
  products: new Set(['avg_cost']),
  sales: new Set(['status']),
};
const DAY_MS = 86_400_000;

type StaffRow = {
  id: string;
  role: Role;
  permissions_json: string;
  active: number;
  deleted_at: number | null;
};
type Current = {
  id: string;
  rev: number;
  deleted_at: number | null;
  setup_completed_at?: number | null;
  hard_limit?: number | null;
};

/** Statements of one op and the index of its guarded write (changes must be 1). */
type Planned = {
  op: PushOp;
  stmts: D1PreparedStatement[];
  result: OpResult;
  guard: number | null;
};

type Group = { txId: string; planned: Planned[] };

type Lookups = {
  staff: Map<string, StaffRow>;
  branches: Map<string, { bill_prefix: string }>;
  current: Map<string, Current>;
  /** Ledger rows already stored (append-only tables have no rev column). */
  existingLedger: Set<string>;
  onHand: Map<string, { on_hand: number; avg_cost: number }>;
  /** Sales that pushed voids and refunds refer to (D-044 same-day voids, 04 §5 refund split). */
  sales: Map<string, SaleInfo>;
  /** Sales created by this push, not in D1 yet. */
  pushedSales: Map<string, SaleInfo>;
  /** Σ refunds.udhaar_part already stored per sale. */
  refundUdhaar: Map<string, number>;
  /** Σ refunds.udhaar_part earlier in this push, per refund row id. */
  pushedRefundBefore: Map<string, number>;
  /** Sale ids that already have a void in D1. */
  existingVoids: Set<string>;
  /** Stored payments / ledger rows linked to pushed refunds and supplier returns (04 §5). */
  linkedPayments: Map<string, LinkedPayment[]>;
  linkedLedger: Map<string, LinkedLedger[]>;
  /** purchase_line_id → supplier_id of its purchase. */
  purchaseLineSupplier: Map<string, string>;
  /** Original expenses referenced by a reversal row in this push. */
  expenses: Map<
    string,
    { amount: number; method: string; reverses_id: string | null }
  >;
  /** Expense ids that already have a stored reversal. */
  existingReversals: Set<string>;
};

type SaleInfo = {
  business_date: string;
  customer_id: string | null;
  udhaar_amount: number;
};
type LinkedPayment = {
  direction: string;
  purpose: string;
  method: string;
  amount: number;
};
type LinkedLedger = {
  party_type: string;
  party_id: string;
  amount: number;
};

const key = (tbl: string, id: string) => `${tbl}:${id}`;

/** Maps a D1 error to a per-op error code (04 §2). */
export function errorCodeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/iu.test(message)) return 'UNIQUE_VIOLATION';
  if (/FOREIGN KEY constraint failed/iu.test(message)) return 'FOREIGN_KEY';
  return 'CONSTRAINT_FAILED';
}

function isD1ConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint failed|cannot store|datatype mismatch|SQLITE_CONSTRAINT|SQLITE_MISMATCH|too many|no such column|has no column/iu.test(
    message,
  );
}

function sqlValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Columns of `row` the server writes: known columns, minus tenant_id, rev and server-managed. */
export function writableColumns(
  tbl: D1Table,
  row: Record<string, unknown>,
): string[] {
  const known = new Set(columnsOf(tbl));
  const managed = SERVER_MANAGED[tbl];
  return Object.keys(row).filter(
    (c) =>
      COLUMN.test(c) &&
      known.has(c) &&
      !NEVER_FROM_CLIENT.has(c) &&
      !(managed?.has(c) ?? false),
  );
}

function changeLog(
  db: TenantDb,
  tbl: D1Table,
  rowId: string,
  op: 'upsert' | 'delete',
  deviceId: string | null,
  at: number,
  onlyIfChanged: boolean,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at) SELECT ?1, ?2, id, ?3, ${rowJsonExpr(tbl)}, ?4, ?5 FROM ${tbl} WHERE tenant_id = ?1 AND id = ?6${onlyIfChanged ? ' AND changes() = 1' : ''}`,
    tbl,
    op,
    deviceId,
    at,
    rowId,
  );
}

function appliedOp(
  db: TenantDb,
  op: PushOp,
  deviceId: string,
  now: number,
  result: OpResult['result'],
  errorCode: string | null,
  onlyIfChanged: boolean,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO applied_ops (tenant_id, op_id, device_id, applied_at, result, error_code) SELECT ?1, ?2, ?3, ?4, ?5, ?6${onlyIfChanged ? ' WHERE changes() = 1' : ''} ON CONFLICT (tenant_id, op_id) DO NOTHING`,
    op.op_id,
    deviceId,
    now,
    result,
    errorCode,
  );
}

class Reject extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function overrideFor(
  group: PushOp[],
  entity: string,
  entityId: string,
  permission: Permission,
  staff: Map<string, StaffRow>,
  roles: readonly Role[] = ['owner', 'manager', 'cashier'],
): boolean {
  return group.some((o) => {
    if (o.tbl !== 'audit_log' || o.kind !== 'insert' || !o.row) return false;
    if (
      o.row.action !== 'override' ||
      o.row.entity !== entity ||
      o.row.entity_id !== entityId
    )
      return false;
    try {
      const after = JSON.parse(String(o.row.after_json ?? '{}')) as {
        permission?: unknown;
        approved_by?: unknown;
      };
      if (
        after.permission !== permission ||
        typeof after.approved_by !== 'string'
      )
        return false;
      const approver = staff.get(after.approved_by);
      return Boolean(
        approver &&
          approver.active === 1 &&
          approver.deleted_at === null &&
          roles.includes(approver.role as Role) &&
          can(approver.role, approver.permissions_json, permission),
      );
    } catch {
      return false;
    }
  });
}

/** Staff rows created by an earlier-or-same op of this group (setup wizard: first owner). */
function staffCreatedInGroup(group: PushOp[], id: string): StaffRow | null {
  for (const o of group) {
    if (o.tbl === 'staff' && o.kind === 'upsert' && o.row?.id === id) {
      const role = o.row.role;
      if (role === 'owner' || role === 'manager' || role === 'cashier') {
        return {
          id,
          role,
          permissions_json: String(o.row.permissions_json ?? '{}'),
          active: o.row.active === 0 ? 0 : 1,
          deleted_at: null,
        };
      }
    }
  }
  return null;
}

/** The only group-created staff allowed to approve rows: the first owner of an empty setup. */
function bootstrapOwnerId(look: Lookups, group: PushOp[]): string | null {
  if (
    [...look.staff.values()].some(
      (s) => s.role === 'owner' && s.active === 1 && s.deleted_at === null,
    ) ||
    look.current.has(key('shop', 'shop'))
  )
    return null;
  const shopOp = group.find(
    (o) => o.tbl === 'shop' && o.kind === 'upsert' && o.row?.id === 'shop',
  );
  const ownerId = shopOp?.row?.updated_by;
  if (
    !shopOp ||
    typeof ownerId !== 'string' ||
    Number(shopOp.row?.setup_completed_at ?? 0) === 0
  )
    return null;
  const owner = group.find(
    (o) =>
      o.tbl === 'staff' &&
      o.kind === 'upsert' &&
      o.row?.id === ownerId &&
      o.row?.updated_by === ownerId &&
      o.row?.role === 'owner',
  );
  return owner ? ownerId : null;
}

function staffOf(look: Lookups, group: PushOp[], id: unknown): StaffRow | null {
  if (typeof id !== 'string') return null;
  const bootstrap = bootstrapOwnerId(look, group);
  const s =
    look.staff.get(id) ??
    (bootstrap !== null && id === bootstrap
      ? staffCreatedInGroup(group, id)
      : null);
  return s && s.active === 1 && s.deleted_at === null ? s : null;
}

function saleOf(
  look: Lookups,
  group: PushOp[],
  saleId: string,
): SaleInfo | undefined {
  const pushed = group.find(
    (o) => o.tbl === 'sales' && o.kind === 'insert' && o.row?.id === saleId,
  )?.row;
  return (
    look.sales.get(saleId) ??
    (pushed
      ? {
          business_date: String(pushed.business_date),
          customer_id:
            typeof pushed.customer_id === 'string' ? pushed.customer_id : null,
          udhaar_amount: Number(pushed.udhaar_amount ?? 0),
        }
      : look.pushedSales.get(saleId))
  );
}

/** Rows of `tbl` in this transaction whose `field` points at `id`. */
function linkedInGroup(
  group: PushOp[],
  tbl: string,
  field: string,
  id: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const o of group)
    if (o.tbl === tbl && o.kind === 'insert' && o.row?.[field] === id)
      out.push(o.row);
  return out;
}

function asPayment(p: Record<string, unknown>): LinkedPayment {
  return {
    direction: String(p.direction),
    purpose: String(p.purpose),
    method: String(p.method),
    amount: Number(p.amount),
  };
}

/** Exactly one payment, with this direction/purpose/method/amount (04 §5). */
function onePayment(
  pays: LinkedPayment[],
  direction: string,
  purpose: string,
  method: unknown,
  amount: number,
): boolean {
  const [p] = pays;
  return (
    pays.length === 1 &&
    p !== undefined &&
    p.direction === direction &&
    p.purpose === purpose &&
    p.method === method &&
    p.amount === amount
  );
}

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
  if (sale && udhaar > 0) {
    if (!sale.customer_id) throw new Reject('CONSTRAINT_FAILED');
    const earlier =
      (look.refundUdhaar.get(saleId) ?? 0) +
      (look.pushedRefundBefore.get(id) ?? 0);
    if (udhaar > sale.udhaar_amount - Math.max(0, earlier))
      throw new Reject('CONSTRAINT_FAILED');
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
  const lines = linkedInGroup(group, 'supplier_return_lines', 'return_id', id);
  if (lines.length !== Number(row.line_count))
    throw new Reject('CONSTRAINT_FAILED');
  let sum = 0;
  for (const l of lines) {
    const total = Number(l.line_total);
    if (total !== mulDivRound(Number(l.qty_milli), Number(l.unit_credit), 1000))
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
    return;
  }
  if (source === 'opening') {
    if (row.party_type !== 'customer' && row.party_type !== 'supplier')
      throw new Reject('CONSTRAINT_FAILED');
    if (amount < 0) throw new Reject('CONSTRAINT_FAILED');
    const partyTable =
      row.party_type === 'customer' ? 'customers' : 'suppliers';
    if (!partyInGroup(group, partyTable, String(row.party_id)))
      throw new Reject('CONSTRAINT_FAILED');
    return;
  }
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
    case 'refund':
      if (
        !allowed('refund.create') &&
        !overrideFor(group, 'refunds', sourceId, 'refund.create', look.staff)
      )
        throw new Reject('FORBIDDEN');
      if (
        row.party_type !== 'customer' ||
        amount !== -Number(src.udhaar_part ?? 0)
      )
        throw new Reject('CONSTRAINT_FAILED');
      break;
    case 'void':
      if (
        !allowed('sale.void') &&
        !overrideFor(group, 'sale_voids', sourceId, 'sale.void', look.staff)
      )
        throw new Reject('FORBIDDEN');
      if (row.party_type !== 'customer' || amount >= 0)
        throw new Reject('CONSTRAINT_FAILED');
      break;
    case 'payment': {
      if (!allowed('payment.receive') && !allowed('purchase.create'))
        throw new Reject('FORBIDDEN');
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
      if (row.party_type !== 'supplier' || amount !== Number(src.total ?? 0))
        throw new Reject('CONSTRAINT_FAILED');
      break;
    case 'supplier_return':
      if (!allowed('purchase.create')) throw new Reject('FORBIDDEN');
      if (row.party_type !== 'supplier' || amount !== -Number(src.total ?? 0))
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
}
function checkOp(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
): void {
  if (!isMasterTable(op.tbl) && !isLedgerTable(op.tbl))
    throw new Reject('UNKNOWN_TABLE');
  if (isLedgerTable(op.tbl) && op.kind !== 'insert')
    throw new Reject('IMMUTABLE_TABLE');
  if (isMasterTable(op.tbl) && op.kind === 'insert')
    throw new Reject('CONSTRAINT_FAILED');
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
    return;
  }
  const row = op.row;
  if (!row || typeof row.id !== 'string' || row.id.length === 0)
    throw new Reject('CONSTRAINT_FAILED');
  if (typeof row.created_at === 'number' && row.created_at > ctx.now + DAY_MS)
    throw new Reject('CONSTRAINT_FAILED');
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
    const cols = new Set(columnsOf(op.tbl as D1Table));
    if (cols.has('device_id') && row.device_id !== ctx.device.id)
      throw new Reject('FORBIDDEN');
    if (cols.has('staff_id') && !staffOf(look, group, row.staff_id))
      throw new Reject('FORBIDDEN');
    const staff = staffOf(look, group, row.staff_id);
    const allowed = (p: Permission) =>
      Boolean(staff && can(staff.role, staff.permissions_json, p));
    switch (op.tbl) {
      case 'sales': {
        // The prefix may come from an earlier bill_prefix setting; the device code is stable and
        // UNIQUE(tenant_id, invoice_no) is the real collision guard (03 §4.1, 07 §2).
        const invoice = /^[A-Z0-9]{1,6}-([A-Z]{1,2})-(\d+)$/u.exec(
          String(row.invoice_no),
        );
        if (
          !invoice ||
          invoice[1] !== ctx.device.device_code ||
          Number(invoice[2]) !== Number(row.invoice_seq)
        )
          throw new Reject('CONSTRAINT_FAILED');
        const lines = linkedInGroup(
          group,
          'sale_lines',
          'sale_id',
          String(row.id),
        );
        if (lines.length === 0) throw new Reject('CONSTRAINT_FAILED');
        if (Number(row.line_count) !== lines.length)
          throw new Reject('CONSTRAINT_FAILED');
        if (
          lines.reduce((sum, line) => sum + Number(line.qty_milli ?? 0), 0) !==
          Number(row.items_qty_milli)
        )
          throw new Reject('CONSTRAINT_FAILED');
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
      case 'supplier_return_lines':
        if (
          Number(row.line_total) !==
          mulDivRound(Number(row.qty_milli), Number(row.unit_credit), 1000)
        )
          throw new Reject('CONSTRAINT_FAILED');
        break;
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
        break;
      }
      case 'sale_lines': {
        if (row.below_cost === 1) {
          const sale = group.find(
            (o) => o.tbl === 'sales' && o.row?.id === row.sale_id,
          )?.row;
          const seller = staffOf(look, group, sale?.staff_id);
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
            row.method !== original.method
          )
            throw new Reject('CONSTRAINT_FAILED');
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
        break;
      case 'cash_moves':
        if (!allowed('cash.move')) throw new Reject('FORBIDDEN');
        break;
      case 'payments': {
        const purpose = String(row.purpose);
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
        break;
      }
      case 'audit_log': {
        if (!CLIENT_AUDIT_ACTIONS.has(String(row.action)))
          throw new Reject('FORBIDDEN');
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
    if (updater?.role !== 'owner' || (!persisted && updater?.id !== bootstrap))
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
  }
  if (
    op.tbl === 'products' ||
    op.tbl === 'categories' ||
    op.tbl === 'product_barcodes'
  ) {
    if (
      !updater ||
      !can(updater.role, updater.permissions_json, 'catalog.edit')
    )
      throw new Reject('FORBIDDEN');
    if (
      op.tbl === 'products' &&
      row.deleted_at != null &&
      !can(updater.role, updater.permissions_json, 'catalog.delete')
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
    // 05 §6: a cashier may create a party, but not edit an existing one or its limits.
    if (updater.role === 'cashier' && look.current.has(key(op.tbl, partyId)))
      throw new Reject('FORBIDDEN');
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

/** Builds the statements of one op (03 §4.1 step 4). Throws Reject for checks it can do. */
function planOp(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  avg: Map<string, { on_hand: number; avg_cost: number }>,
): Planned {
  const { db, now } = ctx;
  const deviceId = ctx.device.id;
  checkOp(ctx, look, group, op);
  const tbl = op.tbl as D1Table;

  if (op.kind === 'delete') {
    const id = op.row_id ?? '';
    const cur = look.current.get(key(tbl, id));
    if (!cur || cur.deleted_at !== null) {
      return {
        op,
        stmts: [appliedOp(db, op, deviceId, now, 'applied', null, false)],
        result: { op_id: op.op_id, result: 'applied' },
        guard: null,
      };
    }
    return {
      op,
      stmts: [
        db.prepare(
          `UPDATE ${tbl} SET deleted_at = ?2, updated_at = ?2, updated_by = ?3, rev = rev + 1 WHERE tenant_id = ?1 AND id = ?4 AND rev = ?5 AND deleted_at IS NULL`,
          now,
          op.updated_by ?? null,
          id,
          cur.rev,
        ),
        appliedOp(db, op, deviceId, now, 'applied', null, true),
        changeLog(db, tbl, id, 'delete', deviceId, now, true),
      ],
      result: { op_id: op.op_id, result: 'applied', server_rev: cur.rev + 1 },
      guard: 0,
    };
  }

  const row = op.row ?? {};
  const id = String(row.id);
  const cols = writableColumns(tbl, row).filter((c) => c !== 'id');

  if (op.kind === 'insert') {
    if (op.tbl === 'sale_voids' && typeof row.sale_id === 'string') {
      const saleId = row.sale_id;
      const duplicateInGroup =
        group
          .filter(
            (candidate) =>
              candidate.tbl === 'sale_voids' &&
              candidate.kind === 'insert' &&
              candidate.row?.sale_id === saleId,
          )
          .indexOf(op) > 0;
      if (look.existingVoids.has(saleId) || duplicateInGroup) {
        return {
          op,
          stmts: [appliedOp(db, op, deviceId, now, 'applied', null, false)],
          result: { op_id: op.op_id, result: 'applied' },
          guard: null,
        };
      }
    }
    // A replay with a fresh op id (restore recovery or a pruned applied_ops row) must
    // not re-run side effects such as the weighted-average update.
    if (
      look.current.has(key(tbl, id)) ||
      look.existingLedger.has(key(tbl, id))
    ) {
      return {
        op,
        stmts: [appliedOp(db, op, deviceId, now, 'applied', null, false)],
        result: { op_id: op.op_id, result: 'applied' },
        guard: null,
      };
    }
    const stmts = [
      db.prepare(
        `INSERT INTO ${tbl} (tenant_id, id${cols.map((c) => `, ${c}`).join('')}) VALUES (?1, ?2${cols.map((_, i) => `, ?${i + 3}`).join('')}) ON CONFLICT (tenant_id, id) DO NOTHING`,
        id,
        ...cols.map((c) => sqlValue(row[c])),
      ),
      changeLog(db, tbl, id, 'upsert', deviceId, now, true),
      appliedOp(db, op, deviceId, now, 'applied', null, false),
      ...sideEffects(ctx, tbl, row, avg),
    ];
    return {
      op,
      stmts,
      result: { op_id: op.op_id, result: 'applied' },
      guard: null,
    };
  }

  // upsert
  const cur = look.current.get(key(tbl, id));
  if (!cur) {
    return {
      op,
      stmts: [
        db.prepare(
          `INSERT INTO ${tbl} (tenant_id, id${cols.map((c) => `, ${c}`).join('')}, rev) VALUES (?1, ?2${cols.map((_, i) => `, ?${i + 3}`).join('')}, 1) ON CONFLICT (tenant_id, id) DO NOTHING`,
          id,
          ...cols.map((c) => sqlValue(row[c])),
        ),
        appliedOp(db, op, deviceId, now, 'applied', null, true),
        changeLog(db, tbl, id, 'upsert', deviceId, now, true),
      ],
      result: { op_id: op.op_id, result: 'applied', server_rev: 1 },
      guard: 0,
    };
  }
  const merge = cur.rev !== (op.base_rev ?? 0);
  let set = merge
    ? cols.filter(
        (c) =>
          (op.changed_fields ?? []).includes(c) ||
          c === 'updated_at' ||
          c === 'updated_by',
      )
    : cols;
  // A delete always wins over a concurrent edit (03 §5).
  if (cur.deleted_at !== null) set = set.filter((c) => c !== 'deleted_at');
  const assignments = [
    ...set.map((c, i) => `${c} = ?${i + 4}`),
    'rev = rev + 1',
  ].join(', ');
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE ${tbl} SET ${assignments} WHERE tenant_id = ?1 AND id = ?2 AND rev = ?3`,
      id,
      cur.rev,
      ...set.map((c) => sqlValue(row[c])),
    ),
  ];
  if (merge) {
    stmts.push(
      db.prepare(
        "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, base_rev, server_rev, fields_json, resolution, at) SELECT ?1, ?2, ?3, ?4, ?5, 'field_merge', ?6, ?7, ?8, 'merged', ?9 WHERE changes() = 1",
        newId(now),
        op.op_id,
        tbl,
        id,
        op.base_rev ?? 0,
        cur.rev,
        JSON.stringify(op.changed_fields ?? []),
        now,
      ),
    );
  }
  stmts.push(
    appliedOp(
      db,
      op,
      deviceId,
      now,
      merge ? 'conflict_merged' : 'applied',
      null,
      true,
    ),
    changeLog(db, tbl, id, 'upsert', deviceId, now, true),
  );
  return {
    op,
    stmts,
    result: {
      op_id: op.op_id,
      result: merge ? 'conflict_merged' : 'applied',
      server_rev: cur.rev + 1,
    },
    guard: 0,
  };
}

/** Derived values the server owns: sales.status, products.avg_cost, conflicts (03 §4.1, §5). */
function sideEffects(
  ctx: ApplyContext,
  tbl: D1Table,
  row: Record<string, unknown>,
  avg: Map<string, { on_hand: number; avg_cost: number }>,
): D1PreparedStatement[] {
  const { db, now } = ctx;
  const out: D1PreparedStatement[] = [];
  const saleStatus = (saleId: string) => [
    db.prepare(
      `UPDATE sales SET status = CASE
         WHEN EXISTS (SELECT 1 FROM sale_voids v WHERE v.tenant_id = ?1 AND v.sale_id = ?2) THEN 'void'
         WHEN (SELECT COALESCE(SUM(r.exact_amount), 0) FROM refunds r WHERE r.tenant_id = ?1 AND r.sale_id = ?2) >= total THEN 'refunded'
         WHEN EXISTS (SELECT 1 FROM refunds r2 WHERE r2.tenant_id = ?1 AND r2.sale_id = ?2) THEN 'part_refunded'
         ELSE 'paid' END
       WHERE tenant_id = ?1 AND id = ?2`,
      saleId,
    ),
    changeLog(db, 'sales', saleId, 'upsert', null, now, false),
  ];
  const conflictLog = (conflictId: string) =>
    db.prepare(
      `INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at) SELECT ?1, 'sync_conflicts', id, 'upsert', ${rowJsonExpr('sync_conflicts')}, NULL, ?2 FROM sync_conflicts WHERE tenant_id = ?1 AND id = ?3 AND changes() = 1`,
      now,
      conflictId,
    );
  if (tbl === 'refunds') {
    const conflictId = newId(now);
    out.push(
      db.prepare(
        "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) SELECT ?1, ?2, '', 'refunds', ?3, 'refund_after_void', json_object('sale_id', ?4, 'row_ids', json_array(?3), 'excess_milli', 0), 'needs_owner', ?5 WHERE EXISTS (SELECT 1 FROM sale_voids WHERE tenant_id = ?1 AND sale_id = ?4)",
        conflictId,
        String(row.id),
        String(row.sale_id),
        now,
      ),
    );
    out.push(conflictLog(conflictId));
    out.push(...saleStatus(String(row.sale_id)));
  }
  if (tbl === 'refunds') {
    const conflictId = newId(now);
    out.push(
      db.prepare(
        `INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at)
         SELECT ?1, ?2, '', 'refunds', ?3, 'over_refund',
           json_object('sale_id', ?4, 'row_ids', json_array(?3), 'excess_milli',
             ?5 - (s.paid_total - COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.tenant_id = ?1 AND r.sale_id = ?4 AND r.id <> ?3), 0))),
           'needs_owner', ?6
         FROM sales s WHERE s.tenant_id = ?1 AND s.id = ?4
           AND ?5 > (s.paid_total - COALESCE((SELECT SUM(r2.amount) FROM refunds r2 WHERE r2.tenant_id = ?1 AND r2.sale_id = ?4 AND r2.id <> ?3), 0))`,
        conflictId,
        String(row.id),
        String(row.sale_id),
        Number(row.amount ?? 0),
        now,
      ),
    );
    out.push(conflictLog(conflictId));
  }
  if (tbl === 'sale_voids') out.push(...saleStatus(String(row.sale_id)));
  if (tbl === 'refund_lines') {
    const conflictId = newId(now);
    out.push(
      db.prepare(
        `INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at)
         SELECT ?1, ?2, '', 'refund_lines', ?3, 'over_refund',
           json_object('sale_id', sl.sale_id, 'row_ids', json_array(?3), 'excess_milli',
             (SELECT SUM(rl.qty_milli) FROM refund_lines rl WHERE rl.tenant_id = ?1 AND rl.sale_line_id = ?4) - sl.qty_milli),
           'needs_owner', ?5
         FROM sale_lines sl WHERE sl.tenant_id = ?1 AND sl.id = ?4
           AND (SELECT SUM(rl2.qty_milli) FROM refund_lines rl2 WHERE rl2.tenant_id = ?1 AND rl2.sale_line_id = ?4) > sl.qty_milli`,
        conflictId,
        String(row.id),
        String(row.sale_line_id),
        now,
      ),
    );
    out.push(conflictLog(conflictId));
  }
  if (
    tbl === 'supplier_return_lines' &&
    typeof row.purchase_line_id === 'string'
  ) {
    const conflictId = newId(now);
    out.push(
      db.prepare(
        `INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at)
         SELECT ?1, ?2, '', 'supplier_return_lines', ?3, 'over_return',
           json_object('purchase_line_id', pl.id, 'row_ids', json_array(?3), 'excess_milli',
             (SELECT SUM(r.qty_milli) FROM supplier_return_lines r WHERE r.tenant_id = ?1 AND r.purchase_line_id = ?4) - pl.qty_milli),
           'needs_owner', ?5
         FROM purchase_lines pl WHERE pl.tenant_id = ?1 AND pl.id = ?4
           AND (SELECT SUM(r2.qty_milli) FROM supplier_return_lines r2 WHERE r2.tenant_id = ?1 AND r2.purchase_line_id = ?4) > pl.qty_milli`,
        conflictId,
        String(row.id),
        row.purchase_line_id,
        now,
      ),
    );
    out.push(conflictLog(conflictId));
  }
  if (tbl === 'stock_movements' && typeof row.product_id === 'string') {
    const qty = Number(row.qty_delta_milli);
    const state = avg.get(row.product_id);
    if (state && Number.isSafeInteger(qty)) {
      if (
        qty > 0 &&
        movementChangesAvgCost(String(row.reason_code)) &&
        Number.isSafeInteger(row.unit_cost) &&
        Number(row.unit_cost) >= 0
      ) {
        try {
          state.avg_cost = nextAvgCost({
            on_hand_milli: state.on_hand,
            avg_cost: state.avg_cost,
            qty_milli: qty,
            unit_cost: Number(row.unit_cost),
          });
        } catch {
          throw new Reject('CONSTRAINT_FAILED');
        }
        out.push(
          db.prepare(
            'UPDATE products SET avg_cost = ?2, last_cost = ?4, rev = rev + 1 WHERE tenant_id = ?1 AND id = ?3 AND (avg_cost <> ?2 OR last_cost <> ?4)',
            state.avg_cost,
            row.product_id,
            Number(row.unit_cost),
          ),
          changeLog(db, 'products', row.product_id, 'upsert', null, now, true),
        );
      }
      state.on_hand += qty;
    }
  }
  if (tbl === 'sales' && Number.isSafeInteger(row.invoice_seq)) {
    out.push(
      db.prepare(
        'UPDATE devices SET last_invoice_seq = ?2 WHERE tenant_id = ?1 AND id = ?3 AND last_invoice_seq < ?2',
        Number(row.invoice_seq),
        ctx.device.id,
      ),
    );
  }
  return out;
}

async function loadLookups(ctx: ApplyContext, ops: PushOp[]): Promise<Lookups> {
  const { db } = ctx;
  const byTable = new Map<string, Set<string>>();
  const ledgerByTable = new Map<string, Set<string>>();
  const products = new Set<string>();
  const saleIds = new Set<string>();
  const refundIds = new Set<string>();
  const returnIds = new Set<string>();
  const purchaseLineIds = new Set<string>();
  const expenseIds = new Set<string>();
  const reversalIds = new Set<string>();
  const pushedSales = new Map<string, SaleInfo>();
  const pushedRefundBefore = new Map<string, number>();
  const refundRunning = new Map<string, number>();
  for (const op of ops) {
    if (
      op.tbl === 'sales' &&
      op.kind !== 'delete' &&
      typeof op.row?.id === 'string'
    )
      pushedSales.set(op.row.id, {
        business_date: String(op.row.business_date ?? ''),
        customer_id:
          typeof op.row.customer_id === 'string' ? op.row.customer_id : null,
        udhaar_amount: Number(op.row.udhaar_amount ?? 0),
      });
    if (
      op.tbl === 'refunds' &&
      op.kind === 'insert' &&
      typeof op.row?.sale_id === 'string'
    ) {
      const saleId = op.row.sale_id;
      pushedRefundBefore.set(String(op.row.id), refundRunning.get(saleId) ?? 0);
      refundRunning.set(
        saleId,
        (refundRunning.get(saleId) ?? 0) + Number(op.row.udhaar_part ?? 0),
      );
    }
    if (
      (op.tbl === 'sale_voids' || op.tbl === 'refunds') &&
      typeof op.row?.sale_id === 'string'
    )
      saleIds.add(op.row.sale_id);
    if (op.tbl === 'refunds' && typeof op.row?.id === 'string')
      refundIds.add(op.row.id);
    if (op.tbl === 'supplier_returns' && typeof op.row?.id === 'string')
      returnIds.add(op.row.id);
    if (
      op.tbl === 'supplier_return_lines' &&
      typeof op.row?.purchase_line_id === 'string'
    )
      purchaseLineIds.add(op.row.purchase_line_id);
    if (isMasterTable(op.tbl)) {
      const id =
        op.kind === 'delete'
          ? op.row_id
          : typeof op.row?.id === 'string'
            ? op.row.id
            : undefined;
      if (id) {
        const set = byTable.get(op.tbl) ?? new Set<string>();
        set.add(id);
        byTable.set(op.tbl, set);
      }
    }
    if (isLedgerTable(op.tbl) && typeof op.row?.id === 'string') {
      const set = ledgerByTable.get(op.tbl) ?? new Set<string>();
      set.add(op.row.id);
      ledgerByTable.set(op.tbl, set);
    }
    if (op.tbl === 'stock_movements' && typeof op.row?.product_id === 'string')
      products.add(op.row.product_id);
    if (
      op.tbl === 'expenses' &&
      op.kind === 'insert' &&
      typeof op.row?.reverses_id === 'string'
    ) {
      reversalIds.add(op.row.reverses_id);
      expenseIds.add(op.row.reverses_id);
    }
  }
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      'SELECT id, role, permissions_json, active, deleted_at FROM staff WHERE tenant_id = ?1',
    ),
    db.prepare('SELECT id, bill_prefix FROM branches WHERE tenant_id = ?1'),
  ];
  const kinds: Array<
    | { tbl: string }
    | { onHand: true }
    | { sales: true }
    | { refundUdhaar: true }
    | { payments: 'refund' | 'sret' }
    | { ledger: true }
    | { purchaseLines: true }
    | { voids: true }
    | { expenses: true }
    | { reversals: true }
    | { ledgerExists: string }
  > = [];
  for (const [tbl, ids] of byTable) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const extra =
        tbl === 'shop'
          ? ', setup_completed_at'
          : tbl === 'customers'
            ? ', hard_limit'
            : '';
      stmts.push(
        db.prepare(
          `SELECT id, rev, deleted_at${extra} FROM ${tbl} WHERE tenant_id = ?1 AND id IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
          ...chunk,
        ),
      );
      kinds.push({ tbl });
    }
  }
  for (const [tbl, ids] of ledgerByTable) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      stmts.push(
        db.prepare(
          `SELECT id FROM ${tbl} WHERE tenant_id = ?1 AND id IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
          ...chunk,
        ),
      );
      kinds.push({ ledgerExists: tbl });
    }
  }
  const productList = [...products];
  for (let i = 0; i < productList.length; i += 90) {
    const chunk = productList.slice(i, i + 90);
    const params = chunk.map((_, j) => `?${j + 2}`).join(', ');
    stmts.push(
      db.prepare(
        `SELECT p.id AS id, p.avg_cost AS avg_cost, COALESCE((SELECT SUM(m.qty_delta_milli) FROM stock_movements m WHERE m.tenant_id = ?1 AND m.product_id = p.id), 0) AS on_hand FROM products p WHERE p.tenant_id = ?1 AND p.id IN (${params})`,
        ...chunk,
      ),
    );
    kinds.push({ onHand: true });
  }
  const chunked = (
    ids: Set<string>,
    sql: (params: string) => string,
    kind: (typeof kinds)[number],
  ) => {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      stmts.push(
        db.prepare(sql(chunk.map((_, j) => `?${j + 2}`).join(', ')), ...chunk),
      );
      kinds.push(kind);
    }
  };
  chunked(
    saleIds,
    (p) =>
      `SELECT id, business_date, customer_id, udhaar_amount FROM sales WHERE tenant_id = ?1 AND id IN (${p})`,
    { sales: true },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT sale_id AS id, SUM(udhaar_part) AS n FROM refunds WHERE tenant_id = ?1 AND sale_id IN (${p}) GROUP BY sale_id`,
    { refundUdhaar: true },
  );
  chunked(
    refundIds,
    (p) =>
      `SELECT refund_id AS id, direction, purpose, method, amount FROM payments WHERE tenant_id = ?1 AND refund_id IN (${p})`,
    { payments: 'refund' },
  );
  chunked(
    returnIds,
    (p) =>
      `SELECT supplier_return_id AS id, direction, purpose, method, amount FROM payments WHERE tenant_id = ?1 AND supplier_return_id IN (${p})`,
    { payments: 'sret' },
  );
  chunked(
    refundIds,
    (p) =>
      `SELECT source_id AS id, party_type, party_id, amount FROM ledger_entries WHERE tenant_id = ?1 AND source_type = 'refund' AND source_id IN (${p})`,
    { ledger: true },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT sale_id AS id FROM sale_voids WHERE tenant_id = ?1 AND sale_id IN (${p})`,
    { voids: true },
  );
  chunked(
    purchaseLineIds,
    (p) =>
      `SELECT pl.id AS id, pu.supplier_id AS supplier_id FROM purchase_lines pl JOIN purchases pu ON pu.tenant_id = ?1 AND pu.id = pl.purchase_id WHERE pl.tenant_id = ?1 AND pl.id IN (${p})`,
    { purchaseLines: true },
  );
  chunked(
    expenseIds,
    (p) =>
      `SELECT id, amount, method, reverses_id FROM expenses WHERE tenant_id = ?1 AND id IN (${p})`,
    { expenses: true },
  );
  chunked(
    reversalIds,
    (p) =>
      `SELECT reverses_id AS id FROM expenses WHERE tenant_id = ?1 AND reverses_id IN (${p})`,
    { reversals: true },
  );
  ctx.budget.take();
  const res = await db.batch(stmts);
  const look: Lookups = {
    sales: new Map(),
    pushedSales,
    refundUdhaar: new Map(),
    pushedRefundBefore,
    existingVoids: new Set(),
    linkedPayments: new Map(),
    linkedLedger: new Map(),
    purchaseLineSupplier: new Map(),
    staff: new Map(),
    branches: new Map(),
    current: new Map(),
    existingLedger: new Set(),
    onHand: new Map(),
    expenses: new Map(),
    existingReversals: new Set(),
  };
  for (const s of (res[0]?.results ?? []) as StaffRow[])
    look.staff.set(s.id, s);
  for (const b of (res[1]?.results ?? []) as {
    id: string;
    bill_prefix: string;
  }[])
    look.branches.set(b.id, { bill_prefix: b.bill_prefix });
  kinds.forEach((k, i) => {
    const rows = (res[i + 2]?.results ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if ('voids' in k) {
        look.existingVoids.add(String(r.id));
        continue;
      }
      if ('reversals' in k) {
        look.existingReversals.add(String(r.id));
        continue;
      }
      if ('expenses' in k) {
        look.expenses.set(String(r.id), {
          amount: Number(r.amount),
          method: String(r.method),
          reverses_id: typeof r.reverses_id === 'string' ? r.reverses_id : null,
        });
        continue;
      }
      if ('ledgerExists' in k) {
        look.existingLedger.add(key(k.ledgerExists, String(r.id)));
        continue;
      }
      if ('tbl' in k) {
        look.current.set(key(k.tbl, String(r.id)), {
          id: String(r.id),
          rev: Number(r.rev),
          deleted_at: (r.deleted_at as number | null) ?? null,
          setup_completed_at:
            (r.setup_completed_at as number | null | undefined) ?? null,
          hard_limit: (r.hard_limit as number | null | undefined) ?? null,
        });
      } else if ('sales' in k) {
        look.sales.set(String(r.id), {
          business_date: String(r.business_date),
          customer_id: typeof r.customer_id === 'string' ? r.customer_id : null,
          udhaar_amount: Number(r.udhaar_amount ?? 0),
        });
      } else if ('refundUdhaar' in k) {
        look.refundUdhaar.set(String(r.id), Number(r.n ?? 0));
      } else if ('payments' in k) {
        const key = `${k.payments}:${String(r.id)}`;
        look.linkedPayments.set(key, [
          ...(look.linkedPayments.get(key) ?? []),
          asPayment(r),
        ]);
      } else if ('ledger' in k) {
        look.linkedLedger.set(String(r.id), [
          ...(look.linkedLedger.get(String(r.id)) ?? []),
          {
            party_type: String(r.party_type),
            party_id: String(r.party_id),
            amount: Number(r.amount),
          },
        ]);
      } else if ('purchaseLines' in k) {
        look.purchaseLineSupplier.set(String(r.id), String(r.supplier_id));
      } else {
        look.onHand.set(String(r.id), {
          on_hand: Number(r.on_hand),
          avg_cost: Number(r.avg_cost),
        });
      }
    }
  });
  return look;
}

/** `applied_ops` answers for op ids already seen (chunks of 100 bound parameters). */
async function alreadyApplied(
  ctx: ApplyContext,
  ops: PushOp[],
): Promise<Map<string, OpResult>> {
  const ids = ops.map((o) => o.op_id);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 99) {
    const chunk = ids.slice(i, i + 99);
    stmts.push(
      ctx.db.prepare(
        `SELECT op_id, result, error_code FROM applied_ops WHERE tenant_id = ?1 AND op_id IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
        ...chunk,
      ),
    );
  }
  ctx.budget.take();
  const res = await ctx.db.batch(stmts);
  const out = new Map<string, OpResult>();
  for (const r of res) {
    for (const row of (r.results ?? []) as Array<{
      op_id: string;
      result: OpResult['result'];
      error_code: string | null;
    }>) {
      out.set(row.op_id, {
        op_id: row.op_id,
        result: row.result,
        ...(row.error_code ? { error_code: row.error_code } : {}),
      });
    }
  }
  return out;
}

function groupByTx(ops: PushOp[]): PushOp[][] {
  const groups: PushOp[][] = [];
  const index = new Map<string, number>();
  for (const op of ops) {
    const at = index.get(op.tx_id);
    if (at === undefined) {
      index.set(op.tx_id, groups.length);
      groups.push([op]);
    } else groups[at]?.push(op);
  }
  return groups;
}

/**
 * Applies a list of ops for one device (03 §4.1 steps 3–7). Returns results in op order for the
 * processed ops; ops not processed (call budget, lost guard twice) are omitted.
 */
export async function applyOps(
  ctx: ApplyContext,
  ops: PushOp[],
): Promise<ApplyOutcome> {
  const { db } = ctx;
  const final = new Map<string, OpResult>();
  let rowsWritten = 0;
  let rowsRead = 0;

  const seen = await alreadyApplied(ctx, ops);
  for (const [id, r] of seen) final.set(id, r);
  const fresh = ops.filter((o) => !seen.has(o.op_id));
  const rejected: Array<{ op: PushOp; code: string }> = [];

  let pending = groupByTx(fresh);
  for (let round = 0; round < 2 && pending.length > 0; round += 1) {
    if (ctx.budget.used >= ctx.budget.max - 2) break;
    const look = await loadLookups(ctx, pending.flat());
    const avg = new Map<string, { on_hand: number; avg_cost: number }>();
    for (const [id, v] of look.onHand) avg.set(id, { ...v });
    // Products created by this push are not in D1 yet, but their opening/purchase movements
    // are planned after them; seed a zero state so the server can compute avg_cost (07 §7).
    for (const op of pending.flat()) {
      if (
        op.tbl !== 'products' ||
        op.kind === 'delete' ||
        typeof op.row?.id !== 'string' ||
        avg.has(op.row.id)
      )
        continue;
      avg.set(op.row.id, {
        on_hand: 0,
        // avg_cost is server-managed; never trust a client value.
        avg_cost: 0,
      });
    }

    const groups: Group[] = [];
    for (const ops of pending) {
      // Plan against a copy so a rejected transaction cannot advance the running
      // weighted-average state used by later transactions.
      const groupAvg = new Map(
        [...avg].map(([id, value]) => [id, { ...value }]),
      );
      try {
        const planned = ops.map((op) => planOp(ctx, look, ops, op, groupAvg));
        groups.push({ txId: ops[0]?.tx_id ?? '', planned });
        for (const [id, value] of groupAvg) avg.set(id, value);
      } catch (error) {
        if (!(error instanceof Reject)) throw error;
        for (const op of ops) rejected.push({ op, code: error.code });
      }
    }

    const lost: PushOp[][] = [];
    const run = async (list: Group[]): Promise<void> => {
      if (list.length === 0) return;
      if (ctx.budget.used >= ctx.budget.max - 1) return; // keep one call for the final batch
      ctx.budget.take();
      try {
        // Parents first (stable), so references inside one push resolve without deferred FKs.
        const ordered = list
          .flatMap((g) => g.planned)
          .map((p, i) => ({ p, i }))
          .sort(
            (x, y) =>
              applyRank(x.p.op.tbl) - applyRank(y.p.op.tbl) || x.i - y.i,
          )
          .map((x) => x.p);
        const res = await db.batch(ordered.flatMap((p) => p.stmts));
        const start = new Map<Planned, number>();
        let at = 0;
        for (const p of ordered) {
          start.set(p, at);
          at += p.stmts.length;
        }
        for (const g of list) {
          let lostGroup = false;
          for (const p of g.planned) {
            const s0 = start.get(p) ?? 0;
            if (
              p.guard !== null &&
              (res[s0 + p.guard]?.meta.changes ?? 0) !== 1
            )
              lostGroup = true;
          }
          for (const p of g.planned) {
            if (lostGroup && p.guard !== null) continue;
            final.set(p.op.op_id, p.result);
          }
          if (lostGroup)
            lost.push(
              g.planned.filter((p) => p.guard !== null).map((p) => p.op),
            );
        }
        for (const r of res) {
          rowsWritten += r.meta.rows_written ?? 0;
          rowsRead += r.meta.rows_read ?? 0;
        }
      } catch (error) {
        if (!isD1ConstraintError(error)) throw error;
        if (list.length === 1) {
          const g = list[0];
          if (g)
            for (const p of g.planned)
              rejected.push({ op: p.op, code: errorCodeOf(error) });
          return;
        }
        const mid = Math.ceil(list.length / 2);
        await run(list.slice(0, mid));
        await run(list.slice(mid));
      }
    };
    await run(groups);
    pending = lost;
  }

  // Rejections are recorded so they are not retried (03 §4.1 step 5); usage ends the request.
  const tail: D1PreparedStatement[] = rejected.map(({ op, code }) =>
    appliedOp(db, op, ctx.device.id, ctx.now, 'rejected', code, false),
  );
  for (const { op, code } of rejected) {
    final.set(op.op_id, {
      op_id: op.op_id,
      result: 'rejected',
      error_code: code,
    });
  }
  return {
    results: ops.flatMap((o) => {
      const r = final.get(o.op_id);
      return r ? [r] : [];
    }),
    rowsWritten,
    rowsRead,
    tail,
  };
}

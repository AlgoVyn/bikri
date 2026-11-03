/**
 * Push algorithm (03 §4.1). Every statement is tenant-scoped through `tenantDb`. Ops are grouped
 * by `tx_id` (one user action); a group is applied or rejected as a whole (D-104).
 */
import {
  allocate,
  allocateRounding,
  can,
  isBelowCost,
  isLedgerTable,
  isMasterTable,
  movementChangesAvgCost,
  mulDivRound,
  newId,
  nextAvgCost,
  type Permission,
  type Role,
  roundTo,
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
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const NEVER_FROM_CLIENT = new Set(['tenant_id', 'rev']);

function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !BUSINESS_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

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
  max_discount_bp: number;
  active: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  rev: number;
};

type ShopRules = {
  tax_rate_bp: number;
  tax_mode: 'exclusive' | 'inclusive';
  round_total_to: number;
  default_credit_limit: number | null;
  updated_at: number;
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
  /** The insert targets a row id that already exists in D1. */
  existingInsert?: boolean;
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
  /** Σ refunds.amount already stored per sale. */
  refundAmount: Map<string, number>;
  /** Σ refunds.udhaar_part earlier in this push, per refund row id. */
  pushedRefundBefore: Map<string, number>;
  /** Σ refunds.amount earlier in this push, per refund row id. */
  pushedRefundAmountBefore: Map<string, number>;
  /** Sale ids that already have a void in D1. */
  existingVoids: Set<string>;
  /** Stored payments / ledger rows linked to pushed refunds and supplier returns (04 §5). */
  linkedPayments: Map<string, LinkedPayment[]>;
  linkedLedger: Map<string, LinkedLedger[]>;
  /** purchase_line_id → supplier_id of its purchase. */
  purchaseLineSupplier: Map<string, string>;
  /** sale_line_id → sale_id, for refund lines that are checked against their refund. */
  saleLineSale: Map<string, string>;
  /** Stored sale lines of refunded/voided sales, for restock repair and checks. */
  saleLinesBySale: Map<
    string,
    { id: string; product_id: string | null; qty_milli: number }[]
  >;
  /** sale_line_id → its sale line, for refund restock repair. */
  saleLineById: Map<
    string,
    { sale_id: string; product_id: string | null; qty_milli: number }
  >;
  /** Stored sale movements of a sale: product → positive qty sold. */
  saleMoved: Map<string, Map<string, number>>;
  /** Parties referenced by payments/ledger rows, for polymorphic party checks. */
  customers: Set<string>;
  suppliers: Set<string>;
  /** Original expenses referenced by a reversal row in this push. */
  expenses: Map<
    string,
    { amount: number; method: string; reverses_id: string | null }
  >;
  /** Expense ids that already have a stored reversal. */
  existingReversals: Set<string>;
  /** Master rows created earlier in this push (`base_rev = 0`), for create-then-delete. */
  pushedCreates: Set<string>;
  /** Current shop policy (tax, rounding, default limits). */
  shop: ShopRules | null;
  /** Stored ledger balance for a party being checked or deleted. */
  partyBalances: Map<string, number>;
  /** Current product price/tracking, for sale price-override policy. */
  products: Map<
    string,
    { price: number; track_stock: number; updated_at: number }
  >;
  /** The latest stored close of each device, for period chaining. */
  lastClose: Map<
    string,
    { id: string; period_end: number; counted_cash: number }
  >;
  /** Closes in this push, so replaying several after a restore can chain across groups. */
  pushedCloses: Map<
    string,
    { id: string; period_end: number; counted_cash: number }[]
  >;
  /** Cash rows for day-close recomputation (D1 plus this push), keyed by row id. */
  closePayments: Map<string, ClosePayment>;
  closeCashMoves: Map<string, CloseCashMove>;
  closeExpenses: Map<string, CloseExpense>;
};

type ClosePayment = {
  id: string;
  device_id: string;
  direction: string;
  purpose: string;
  method: string;
  amount: number;
  created_at: number;
};
type CloseCashMove = {
  id: string;
  device_id: string;
  kind: string;
  amount: number;
  created_at: number;
};
type CloseExpense = {
  id: string;
  device_id: string;
  amount: number;
  method: string;
  reverses_id: string | null;
  created_at: number;
};

type SaleInfo = {
  business_date: string;
  branch_id: string;
  customer_id: string | null;
  udhaar_amount: number;
  paid_total: number;
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

/** Stable row identity of an op, used to detect duplicate row ids in one push. */
function opRowKey(op: PushOp): string | null {
  const id = op.kind === 'delete' ? op.row_id : op.row?.id;
  return typeof id === 'string' && id !== '' ? key(op.tbl, id) : null;
}

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

/** A D1-level rejection stops the rest of this round: later groups were planned against a
 * weighted-average state that included the rejected group, so they must be planned again
 * (or deferred to the client) instead of being applied with a phantom average. */
class StopExecution extends Error {}

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
      const approver =
        staff.get(after.approved_by) ??
        staffCreatedInGroup(group, after.approved_by);
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

/** A catalog price override is bound to one cart line and price, and to a permitted staff. */
function overrideForLine(
  look: Lookups,
  group: PushOp[],
  entity: string,
  entityId: string,
  lineId: string,
  price: number,
): boolean {
  return group.some((op) => {
    if (op.tbl !== 'audit_log' || op.kind !== 'insert' || !op.row) return false;
    if (
      op.row.action !== 'override' ||
      op.row.entity !== entity ||
      op.row.entity_id !== entityId
    )
      return false;
    try {
      const after = JSON.parse(String(op.row.after_json ?? '{}')) as {
        permission?: unknown;
        approved_by?: unknown;
        bound_line?: unknown;
        bound_price?: unknown;
      };
      if (
        after.permission !== 'catalog.edit' ||
        typeof after.approved_by !== 'string' ||
        after.bound_line !== lineId ||
        Number(after.bound_price) !== price
      )
        return false;
      const approver =
        look.staff.get(after.approved_by) ??
        staffCreatedInGroup(group, after.approved_by);
      return Boolean(
        approver &&
          approver.active === 1 &&
          approver.deleted_at === null &&
          can(approver.role, approver.permissions_json, 'catalog.edit'),
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
          max_discount_bp: Number(o.row.max_discount_bp ?? 500),
          active: o.row.active === 0 ? 0 : 1,
          deleted_at: null,
          created_at: Number(o.row.created_at ?? 0),
          updated_at: Number(o.row.updated_at ?? 0),
          rev: Number(o.row.rev ?? 0),
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

/**
 * A staff row created in this action may be used by the other rows of the same action, but
 * only when an owner (already persisted, or the first owner of setup) created it. This lets
 * restore recovery group a new cashier with the rows they created without weakening the
 * “only an owner may add staff” rule.
 */
function groupStaffAuthorized(
  look: Lookups,
  group: PushOp[],
  id: string,
  seen: Set<string> = new Set(),
): StaffRow | null {
  if (seen.has(id)) return null;
  seen.add(id);
  const created = staffCreatedInGroup(group, id);
  if (!created) return null;
  const op = group.find(
    (candidate) =>
      candidate.tbl === 'staff' &&
      candidate.kind === 'upsert' &&
      candidate.row?.id === id,
  );
  const updater = op?.row?.updated_by;
  if (typeof updater === 'string') {
    const owner = look.staff.get(updater);
    if (
      owner?.role === 'owner' &&
      owner.active === 1 &&
      owner.deleted_at === null
    )
      return created;
    // A new owner created by a persisted owner can in turn create a cashier in the
    // same restore-recovery transaction.
    const groupOwner = groupStaffAuthorized(look, group, updater, seen);
    if (groupOwner?.role === 'owner') return created;
  }
  return bootstrapOwnerId(look, group) === id ? created : null;
}

function staffOf(look: Lookups, group: PushOp[], id: unknown): StaffRow | null {
  if (typeof id !== 'string') return null;
  const s = look.staff.get(id) ?? groupStaffAuthorized(look, group, id);
  return s && s.active === 1 && s.deleted_at === null ? s : null;
}

/**
 * Staff for a historical ledger row: the person may have been deactivated or deleted
 * after they rang the sale. Accept a row whose `created_at` predates the deactivation
 * (`updated_at` when active = 0) or deletion (`deleted_at`), so offline sales survive
 * normal end-of-shift staff turnover.
 */
function staffForHistory(
  look: Lookups,
  group: PushOp[],
  id: unknown,
  at: unknown,
): StaffRow | null {
  if (typeof id !== 'string') return null;
  const s = look.staff.get(id) ?? groupStaffAuthorized(look, group, id);
  if (!s) return null;
  if (s.active === 1 && s.deleted_at === null) return s;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (s.deleted_at !== null && at <= s.deleted_at) return s;
  if (s.active !== 1 && s.deleted_at === null && at <= s.updated_at) return s;
  return null;
}

/** The row a staff upsert will actually leave, applying merge field selection. */
function effectiveStaff(
  look: Lookups,
  op: PushOp,
): { role: string; active: number; deleted_at: number | null } | null {
  const id = op.kind === 'delete' ? op.row_id : op.row?.id;
  if (typeof id !== 'string' || !op.row) return null;
  const current = look.staff.get(id);
  if (!current) {
    return {
      role: String(op.row.role ?? ''),
      active: Number(op.row.active ?? 1),
      deleted_at:
        op.row.deleted_at === null || op.row.deleted_at === undefined
          ? null
          : Number(op.row.deleted_at),
    };
  }
  const changed = op.changed_fields ?? [];
  const merge = current.rev !== (op.base_rev ?? 0);
  const pick = (field: 'role' | 'active' | 'deleted_at') => {
    const raw = op.row?.[field];
    if (merge && !changed.includes(field)) return current[field];
    return raw === undefined ? current[field] : raw;
  };
  const deleted = pick('deleted_at');
  return {
    role: String(pick('role') ?? ''),
    active: Number(pick('active') ?? 0),
    deleted_at:
      deleted === null || deleted === undefined ? null : Number(deleted),
  };
}

/** Active owners left after every staff op in this transaction has been applied. */
function ownersAfterPush(look: Lookups, group: PushOp[]): Set<string> {
  const owners = new Set(
    [...look.staff.values()]
      .filter(
        (s) => s.role === 'owner' && s.active === 1 && s.deleted_at === null,
      )
      .map((s) => s.id),
  );
  for (const op of group) {
    if (op.tbl !== 'staff') continue;
    const id =
      op.kind === 'delete'
        ? op.row_id
        : typeof op.row?.id === 'string'
          ? op.row.id
          : undefined;
    if (!id) continue;
    if (op.kind === 'delete') {
      owners.delete(id);
      continue;
    }
    const next = effectiveStaff(look, op);
    if (next?.role === 'owner' && next.active === 1 && next.deleted_at === null)
      owners.add(id);
    else owners.delete(id);
  }
  return owners;
}

function assertOwnerRemains(look: Lookups, group: PushOp[]): void {
  if (ownersAfterPush(look, group).size === 0)
    throw new Reject('CONSTRAINT_FAILED');
}

/** Only demoting/deactivating/deleting a stored owner can remove the last owner. */
function removesOwner(look: Lookups, op: PushOp): boolean {
  const id = op.kind === 'delete' ? op.row_id : op.row?.id;
  const current = typeof id === 'string' ? look.staff.get(id) : undefined;
  if (current === undefined) return false;
  if (
    current.role !== 'owner' ||
    current.active !== 1 ||
    current.deleted_at !== null
  )
    return false;
  if (op.kind === 'delete') return true;
  const next = effectiveStaff(look, op);
  if (!next) return false;
  return next.role !== 'owner' || next.active !== 1 || next.deleted_at !== null;
}

function partyExists(
  look: Lookups,
  group: PushOp[],
  type: unknown,
  id: unknown,
): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (type === 'customer')
    return (
      look.customers.has(id) ||
      group.some(
        (o) => o.tbl === 'customers' && o.row?.id === id && o.kind !== 'delete',
      )
    );
  if (type === 'supplier')
    return (
      look.suppliers.has(id) ||
      group.some(
        (o) => o.tbl === 'suppliers' && o.row?.id === id && o.kind !== 'delete',
      )
    );
  return false;
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
          branch_id: String(pushed.branch_id),
          customer_id:
            typeof pushed.customer_id === 'string' ? pushed.customer_id : null,
          udhaar_amount: Number(pushed.udhaar_amount ?? 0),
          paid_total: Number(pushed.paid_total ?? 0),
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
    if (!partyExists(look, group, row.party_type, row.party_id))
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
      !partyExists(look, group, row.party_type, row.party_id) ||
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
    const received = linkedInGroup(group, 'purchase_lines', 'purchase_id', ref)
      .filter((line) => line.product_id === productId)
      .reduce((sum, line) => sum + Number(line.qty_milli ?? 0), 0);
    const moved = movementsFor(ref, productId).reduce(
      (sum, movement) => sum + Number(movement.row?.qty_delta_milli ?? 0),
      0,
    );
    if (qty <= 0 || received <= 0 || moved > received)
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
}

/** Deliveries are reconciled with their lines, charges and paid-now payment (07 §7). */
function checkPurchase(
  look: Lookups,
  group: PushOp[],
  row: Record<string, unknown>,
): void {
  const id = String(row.id);
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
}
/** Sales are reconciled with their lines, payments and udhaar ledger row (07 §2). */
function checkSaleInsert(group: PushOp[], row: Record<string, unknown>): void {
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
  const createdAt = n(row.created_at);
  const taxRate = n(row.tax_rate_bp);
  const inclusive = Number(row.tax_inclusive) === 1;
  // A shop setting only governs sales made after it changed; an offline sale keeps the
  // snapshot it was rung with.
  const fresh = look.shop !== null && createdAt >= look.shop.updated_at;
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
    const product =
      typeof line.product_id === 'string'
        ? look.products.get(line.product_id)
        : undefined;
    if (
      product &&
      n(line.created_at) >= product.updated_at &&
      unitPrice < product.price &&
      !allowed('catalog.edit') &&
      !overrideForLine(look, group, 'sales', saleId, String(line.id), unitPrice)
    )
      throw new Reject('FORBIDDEN');
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
    const limitFresh = !staff || createdAt >= staff.updated_at;
    if (
      limitFresh &&
      share > maxBp &&
      !overrideFor(group, 'sales', saleId, 'sale.discount', look.staff)
    )
      throw new Reject('FORBIDDEN');
  }
  if (n(row.udhaar_amount) > 0 && !allowed('sale.udhaar'))
    throw new Reject('FORBIDDEN');
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
        checkSaleInsert(group, row);
        try {
          checkSalePolicy(look, group, row, staff, allowed);
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
          !partyExists(look, group, row.party_type, row.party_id)
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
      changes.length > 0 &&
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
      // A create and a delete can be queued before the same sync (for example a product
      // created and removed while offline). The create is applied earlier in this push,
      // so the delete must still soft-delete the new row instead of being a no-op.
      if (!cur && look.pushedCreates.has(key(tbl, id))) {
        return {
          op,
          stmts: [
            db.prepare(
              `UPDATE ${tbl} SET deleted_at = ?2, updated_at = ?2, updated_by = ?3, rev = rev + 1 WHERE tenant_id = ?1 AND id = ?4 AND deleted_at IS NULL`,
              now,
              op.updated_by ?? null,
              id,
            ),
            appliedOp(db, op, deviceId, now, 'applied', null, false),
            changeLog(db, tbl, id, 'delete', deviceId, now, true),
          ],
          result: { op_id: op.op_id, result: 'applied' },
          guard: null,
        };
      }
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
      const duplicateInGroup = group.some(
        (candidate) =>
          candidate !== op &&
          candidate.tbl === 'sale_voids' &&
          candidate.kind === 'insert' &&
          candidate.row?.sale_id === saleId,
      );
      // A second void for the same sale must never be half-accepted: its payment,
      // ledger and stock rows would be applied even though the void header is unique.
      // `applied_ops` already handles a replay of the same op id.
      if (look.existingVoids.has(saleId) || duplicateInGroup)
        throw new Reject('CONSTRAINT_FAILED');
    }
    // A replay with a fresh op id (restore recovery or a pruned applied_ops row) must
    // not re-run side effects such as the weighted-average update. If this transaction
    // also introduces new companion rows, the group-level check rejects it instead of
    // attaching them to the stored document.
    if (
      look.current.has(key(tbl, id)) ||
      look.existingLedger.has(key(tbl, id))
    ) {
      return {
        op,
        stmts: [appliedOp(db, op, deviceId, now, 'applied', null, false)],
        result: { op_id: op.op_id, result: 'applied' },
        guard: null,
        existingInsert: true,
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
    if (
      tbl === 'sales' ||
      tbl === 'purchases' ||
      tbl === 'supplier_returns' ||
      tbl === 'refunds' ||
      tbl === 'sale_voids'
    )
      stmts.push(...stockRepairStatements(ctx, look, group, tbl, row, avg));
    if (
      tbl === 'refunds' ||
      tbl === 'sale_voids' ||
      tbl === 'supplier_returns' ||
      tbl === 'day_closes'
    )
      stmts.push(...moneyAuditStatements(ctx, group, tbl, row));
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
    const conflictId = newId(now);
    stmts.push(
      db.prepare(
        "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, base_rev, server_rev, fields_json, resolution, at) SELECT ?1, ?2, ?3, ?4, ?5, 'field_merge', ?6, ?7, ?8, 'merged', ?9 WHERE changes() = 1",
        conflictId,
        op.op_id,
        tbl,
        id,
        op.base_rev ?? 0,
        cur.rev,
        JSON.stringify(op.changed_fields ?? []),
        now,
      ),
      // Other conflict kinds log themselves; a field merge must reach existing tills too.
      changeLog(
        db,
        'sync_conflicts',
        conflictId,
        'upsert',
        deviceId,
        now,
        true,
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
  if (tbl === 'sale_voids') {
    // The reverse race (a refund already left the shop when this void arrives) is the
    // same money conflict; accept the real event and let the owner settle it.
    const conflictId = newId(now);
    out.push(
      db.prepare(
        "INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) SELECT ?1, ?2, '', 'sale_voids', ?3, 'refund_after_void', json_object('sale_id', ?4, 'row_ids', json_array(?3), 'excess_milli', 0), 'needs_owner', ?5 WHERE EXISTS (SELECT 1 FROM refunds WHERE tenant_id = ?1 AND sale_id = ?4)",
        conflictId,
        String(row.id),
        String(row.sale_id),
        now,
      ),
    );
    out.push(conflictLog(conflictId));
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

/**
 * Money-event audit integrity: verify the row the till sent with the event, or write the
 * canonical row here when it is missing. Refund/void/supplier-return/day-close amounts
 * are compared with the event, so a forged audit cannot disagree with the money row.
 */
function moneyAuditStatements(
  ctx: ApplyContext,
  group: PushOp[],
  tbl: string,
  row: Record<string, unknown>,
): D1PreparedStatement[] {
  const n = (value: unknown): number => Number(value ?? 0);
  const id = String(row.id);
  const entity =
    tbl === 'refunds'
      ? 'refunds'
      : tbl === 'sale_voids'
        ? 'sale_voids'
        : tbl === 'supplier_returns'
          ? 'supplier_returns'
          : 'day_closes';
  const replacement =
    typeof row.replacement_sale_id === 'string'
      ? row.replacement_sale_id
      : null;
  const expectedAction =
    tbl === 'refunds'
      ? 'refund'
      : tbl === 'sale_voids'
        ? replacement === null
          ? 'void'
          : 'reissue'
        : tbl === 'supplier_returns'
          ? 'supplier_return'
          : 'day_close_difference';
  const actionMatches = (action: unknown) =>
    tbl === 'sale_voids'
      ? action === 'void' || action === 'reissue'
      : action === expectedAction;
  const auditRows = group.filter(
    (candidate) =>
      candidate.tbl === 'audit_log' &&
      candidate.kind === 'insert' &&
      candidate.row?.entity === entity &&
      candidate.row?.entity_id === id &&
      actionMatches(candidate.row?.action),
  );
  const matching = auditRows.filter((candidate) =>
    tbl === 'sale_voids'
      ? candidate.row?.action === (replacement === null ? 'void' : 'reissue')
      : candidate.row?.action === expectedAction,
  );
  if (auditRows.length > 1 || matching.length > 1)
    throw new Reject('CONSTRAINT_FAILED');
  let after: Record<string, unknown> | null = null;
  if (tbl === 'refunds') {
    after = {
      sale_id: String(row.sale_id),
      reason: String(row.reason),
      exact: n(row.exact_amount),
      udhaar_part: n(row.udhaar_part),
      amount: n(row.amount),
      rounding: n(row.rounding),
      method:
        typeof row.method === 'string' && row.method.length > 0
          ? row.method
          : null,
    };
  } else if (tbl === 'sale_voids') {
    after = {
      sale_id: String(row.sale_id),
      reason: String(row.reason),
      replacement_sale_id: replacement,
    };
  } else if (tbl === 'supplier_returns') {
    after = {
      total: n(row.total),
      refund_received: n(row.refund_received),
      line_count: n(row.line_count),
      reason: String(row.reason),
    };
  } else {
    const difference = n(row.difference);
    if (Math.abs(difference) < 10_000) {
      if (auditRows.length > 0) throw new Reject('CONSTRAINT_FAILED');
      return [];
    }
    after = { difference, note: String(row.note ?? '') };
  }
  const found = matching[0]?.row;
  if (found) {
    if (
      found.device_id !== String(row.device_id) ||
      found.staff_id !== String(row.staff_id)
    )
      throw new Reject('CONSTRAINT_FAILED');
    try {
      const sent = JSON.parse(String(found.after_json ?? '{}')) as Record<
        string,
        unknown
      >;
      const keys = Object.keys(after);
      if (
        tbl === 'sale_voids'
          ? found.action !== (replacement === null ? 'void' : 'reissue')
          : found.action !== expectedAction
      )
        throw new Reject('CONSTRAINT_FAILED');
      for (const key of keys) {
        const left = sent[key] ?? null;
        const right = after[key] ?? null;
        if (typeof right === 'number') {
          if (typeof left !== 'number' || left !== right)
            throw new Reject('CONSTRAINT_FAILED');
        } else if (left !== right) {
          throw new Reject('CONSTRAINT_FAILED');
        }
      }
    } catch (error) {
      if (error instanceof Reject) throw error;
      throw new Reject('CONSTRAINT_FAILED');
    }
    return [];
  }
  const auditId = newId(ctx.now);
  const auditRow = {
    id: auditId,
    action: expectedAction,
    entity,
    entity_id: id,
    before_json: null,
    after_json: JSON.stringify(after),
    device_id: String(row.device_id),
    staff_id: String(row.staff_id),
    created_at: n(row.created_at),
  };
  return [
    ctx.db.insert('audit_log', auditRow),
    changeLog(
      ctx.db,
      'audit_log',
      auditId,
      'upsert',
      String(row.device_id),
      ctx.now,
      true,
    ),
  ];
}

/**
 * Server-authored stock rows for a document whose till omitted a movement (an old build,
 * a bug, or a restored document). The money rows are accepted; stock must still be right.
 * Only new documents are repaired here; a replay of a stored document is a no-op.
 */
function stockRepairStatements(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  tbl: string,
  row: Record<string, unknown>,
  avg: Map<string, { on_hand: number; avg_cost: number }>,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const number = (value: unknown): number => Number(value ?? 0);
  const id = String(row.id);
  const deviceId = String(row.device_id);
  const branchId =
    typeof row.branch_id === 'string'
      ? row.branch_id
      : tbl === 'sale_voids'
        ? (look.sales.get(String(row.sale_id))?.branch_id ?? '')
        : '';
  const staffId = String(row.staff_id);
  const businessDate = String(row.business_date);
  const createdAt = number(row.created_at);
  const movements = (reason: string, refId: string, productId: string) =>
    group.filter(
      (candidate) =>
        candidate.tbl === 'stock_movements' &&
        candidate.kind === 'insert' &&
        candidate.row?.reason_code === reason &&
        candidate.row?.ref_id === refId &&
        candidate.row?.product_id === productId,
    );
  const addMovement = (
    productId: string,
    qty: number,
    reason: string,
    refType: string,
    refId: string,
    unitCost: number | null,
  ) => {
    if (!Number.isSafeInteger(qty) || qty === 0) return;
    const movement = {
      id: newId(ctx.now),
      product_id: productId,
      qty_delta_milli: qty,
      reason_code: reason,
      ref_type: refType,
      ref_id: refId,
      unit_cost: unitCost,
      note: '',
      branch_id: branchId,
      device_id: deviceId,
      staff_id: staffId,
      business_date: businessDate,
      created_at: createdAt,
    };
    out.push(
      ctx.db.insert('stock_movements', movement),
      changeLog(
        ctx.db,
        'stock_movements',
        movement.id,
        'upsert',
        deviceId,
        ctx.now,
        true,
      ),
    );
    if (
      qty > 0 &&
      movementChangesAvgCost(reason) &&
      unitCost !== null &&
      Number.isSafeInteger(unitCost)
    )
      out.push(...sideEffects(ctx, 'stock_movements', movement, avg));
  };
  const grouped = (
    lines: Record<string, unknown>[],
    key: 'qty_milli',
  ): Map<string, { qty: number; latest: number }> => {
    const map = new Map<string, { qty: number; latest: number }>();
    for (const line of lines) {
      const productId = line.product_id;
      if (typeof productId !== 'string') continue;
      const current = map.get(productId) ?? { qty: 0, latest: 0 };
      current.qty += number(line[key]);
      current.latest = Math.max(current.latest, number(line.created_at));
      map.set(productId, current);
    }
    return map;
  };

  if (tbl === 'sales') {
    const lines = linkedInGroup(group, 'sale_lines', 'sale_id', id);
    for (const [productId, info] of grouped(lines, 'qty_milli')) {
      const product = look.products.get(productId);
      if (product?.track_stock !== 1 || info.latest < product.updated_at)
        continue;
      const moved = movements('sale', id, productId).reduce(
        (sum, movement) => sum - number(movement.row?.qty_delta_milli),
        0,
      );
      const missing = info.qty - moved;
      if (missing > 0)
        addMovement(productId, -missing, 'sale', 'sale', id, null);
    }
  }

  if (tbl === 'purchases') {
    const lines = linkedInGroup(group, 'purchase_lines', 'purchase_id', id);
    for (const [productId, info] of grouped(lines, 'qty_milli')) {
      const product = look.products.get(productId);
      if (product?.track_stock !== 1 || info.latest < product.updated_at)
        continue;
      const moved = movements('purchase', id, productId).reduce(
        (sum, movement) => sum + number(movement.row?.qty_delta_milli),
        0,
      );
      const missing = info.qty - moved;
      if (missing <= 0) continue;
      const cost = lines
        .filter((line) => line.product_id === productId)
        .reduce(
          (sum, line) =>
            sum + number(line.qty_milli) * number(line.landed_unit_cost),
          0,
        );
      const unitCost = info.qty > 0 ? mulDivRound(cost, 1, info.qty) : null;
      if (unitCost !== null && !Number.isSafeInteger(unitCost)) continue;
      addMovement(productId, missing, 'purchase', 'purchase', id, unitCost);
    }
  }

  if (tbl === 'supplier_returns') {
    const lines = linkedInGroup(
      group,
      'supplier_return_lines',
      'return_id',
      id,
    );
    for (const [productId, info] of grouped(lines, 'qty_milli')) {
      const product = look.products.get(productId);
      if (product?.track_stock !== 1 || info.latest < product.updated_at)
        continue;
      const moved = movements('supplier_return', id, productId).reduce(
        (sum, movement) => sum + -number(movement.row?.qty_delta_milli),
        0,
      );
      const missing = info.qty - moved;
      if (missing > 0)
        addMovement(
          productId,
          -missing,
          'supplier_return',
          'supplier_return',
          id,
          null,
        );
    }
  }

  if (tbl === 'refunds') {
    const saleId = String(row.sale_id);
    const lines = linkedInGroup(group, 'refund_lines', 'refund_id', id);
    const byProduct = new Map<string, number>();
    for (const line of lines) {
      if (line.restock !== 1) continue;
      const saleLine = look.saleLineById.get(String(line.sale_line_id));
      if (!saleLine?.product_id) continue;
      byProduct.set(
        saleLine.product_id,
        (byProduct.get(saleLine.product_id) ?? 0) + number(line.qty_milli),
      );
    }
    for (const [productId, qty] of byProduct) {
      const sold =
        (look.saleMoved.get(saleId)?.get(productId) ?? 0) +
        movements('sale', saleId, productId).reduce(
          (sum, movement) => sum - number(movement.row?.qty_delta_milli),
          0,
        );
      if (sold <= 0) continue;
      const moved = movements('refund_return', id, productId).reduce(
        (sum, movement) => sum + number(movement.row?.qty_delta_milli),
        0,
      );
      const missing = qty - moved;
      if (missing > 0)
        addMovement(productId, missing, 'refund_return', 'refund', id, null);
    }
  }

  if (tbl === 'sale_voids') {
    const saleId = String(row.sale_id);
    for (const line of look.saleLinesBySale.get(saleId) ?? []) {
      if (!line.product_id) continue;
      const sold =
        (look.saleMoved.get(saleId)?.get(line.product_id) ?? 0) +
        movements('sale', saleId, line.product_id).reduce(
          (sum, movement) => sum - number(movement.row?.qty_delta_milli),
          0,
        );
      if (sold <= 0) continue;
      const moved = movements('void_return', id, line.product_id).reduce(
        (sum, movement) => sum + number(movement.row?.qty_delta_milli),
        0,
      );
      const missing = sold - moved;
      if (missing > 0)
        addMovement(line.product_id, missing, 'void_return', 'void', id, null);
    }
  }
  return out;
}

async function loadLookups(ctx: ApplyContext, ops: PushOp[]): Promise<Lookups> {
  const { db } = ctx;
  const byTable = new Map<string, Set<string>>();
  const ledgerByTable = new Map<string, Set<string>>();
  const products = new Set<string>();
  const saleProductIds = new Set<string>();
  const saleIds = new Set<string>();
  const refundIds = new Set<string>();
  const returnIds = new Set<string>();
  const purchaseIds = new Set<string>();
  const purchaseLineIds = new Set<string>();
  const refundLineIds = new Set<string>();
  const expenseIds = new Set<string>();
  const reversalIds = new Set<string>();
  const partyIds = {
    customer: new Set<string>(),
    supplier: new Set<string>(),
  };
  const deleteParties = {
    customer: new Set<string>(),
    supplier: new Set<string>(),
  };
  const closeDevices = new Set<string>();
  let closeStart = Number.POSITIVE_INFINITY;
  let closeEnd = Number.NEGATIVE_INFINITY;
  const pushedClosePayments = new Map<string, ClosePayment>();
  const pushedCloseCashMoves = new Map<string, CloseCashMove>();
  const pushedCloseExpenses = new Map<string, CloseExpense>();
  const pushedCloses = new Map<
    string,
    { id: string; period_end: number; counted_cash: number }[]
  >();
  const pushedSales = new Map<string, SaleInfo>();
  const pushedRefundBefore = new Map<string, number>();
  const pushedRefundAmountBefore = new Map<string, number>();
  const refundRunning = new Map<string, number>();
  const amountRunning = new Map<string, number>();
  for (const op of ops) {
    if (
      op.tbl === 'sales' &&
      op.kind !== 'delete' &&
      typeof op.row?.id === 'string'
    )
      pushedSales.set(op.row.id, {
        business_date: String(op.row.business_date ?? ''),
        branch_id: String(op.row.branch_id ?? ''),
        customer_id:
          typeof op.row.customer_id === 'string' ? op.row.customer_id : null,
        udhaar_amount: Number(op.row.udhaar_amount ?? 0),
        paid_total: Number(op.row.paid_total ?? 0),
      });
    if (
      op.tbl === 'refunds' &&
      op.kind === 'insert' &&
      typeof op.row?.sale_id === 'string'
    ) {
      const saleId = op.row.sale_id;
      pushedRefundBefore.set(String(op.row.id), refundRunning.get(saleId) ?? 0);
      pushedRefundAmountBefore.set(
        String(op.row.id),
        amountRunning.get(saleId) ?? 0,
      );
      refundRunning.set(
        saleId,
        (refundRunning.get(saleId) ?? 0) + Number(op.row.udhaar_part ?? 0),
      );
      amountRunning.set(
        saleId,
        (amountRunning.get(saleId) ?? 0) + Number(op.row.amount ?? 0),
      );
    }
    if (
      (op.tbl === 'sale_voids' || op.tbl === 'refunds') &&
      typeof op.row?.sale_id === 'string'
    )
      saleIds.add(op.row.sale_id);
    if (op.tbl === 'refunds' && typeof op.row?.id === 'string')
      refundIds.add(op.row.id);
    if (op.tbl === 'refund_lines' && typeof op.row?.sale_line_id === 'string')
      refundLineIds.add(op.row.sale_line_id);
    if (op.tbl === 'sale_lines' && typeof op.row?.product_id === 'string')
      saleProductIds.add(op.row.product_id);
    if (
      (op.tbl === 'purchase_lines' || op.tbl === 'supplier_return_lines') &&
      typeof op.row?.product_id === 'string'
    )
      saleProductIds.add(op.row.product_id);
    if (
      op.tbl === 'day_closes' &&
      op.kind === 'insert' &&
      typeof op.row?.device_id === 'string'
    ) {
      closeDevices.add(op.row.device_id);
      closeStart = Math.min(closeStart, Number(op.row.period_start));
      closeEnd = Math.max(closeEnd, Number(op.row.period_end));
      const list = pushedCloses.get(op.row.device_id) ?? [];
      list.push({
        id: String(op.row.id),
        period_end: Number(op.row.period_end),
        counted_cash: Number(op.row.counted_cash),
      });
      pushedCloses.set(op.row.device_id, list);
    }
    if (op.tbl === 'supplier_returns' && typeof op.row?.id === 'string')
      returnIds.add(op.row.id);
    if (
      op.tbl === 'purchases' &&
      op.kind === 'insert' &&
      typeof op.row?.id === 'string'
    )
      purchaseIds.add(op.row.id);
    if (
      op.tbl === 'supplier_return_lines' &&
      typeof op.row?.purchase_line_id === 'string'
    )
      purchaseLineIds.add(op.row.purchase_line_id);
    if (
      op.kind === 'delete' &&
      op.row_id &&
      (op.tbl === 'customers' || op.tbl === 'suppliers')
    )
      deleteParties[op.tbl === 'customers' ? 'customer' : 'supplier'].add(
        op.row_id,
      );
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
      (op.tbl === 'purchase_lines' || op.tbl === 'supplier_return_lines') &&
      typeof op.row?.product_id === 'string'
    )
      products.add(op.row.product_id);
    if (
      op.tbl === 'expenses' &&
      op.kind === 'insert' &&
      typeof op.row?.reverses_id === 'string'
    ) {
      reversalIds.add(op.row.reverses_id);
      expenseIds.add(op.row.reverses_id);
    }
    if (
      (op.tbl === 'payments' || op.tbl === 'ledger_entries') &&
      typeof op.row?.party_id === 'string'
    ) {
      if (op.row.party_type === 'customer')
        partyIds.customer.add(op.row.party_id);
      if (op.row.party_type === 'supplier')
        partyIds.supplier.add(op.row.party_id);
    }
  }
  if (closeDevices.size > 0) {
    for (const op of ops) {
      if (op.kind !== 'insert' || !op.row) continue;
      const deviceId =
        typeof op.row.device_id === 'string' ? op.row.device_id : '';
      if (!closeDevices.has(deviceId)) continue;
      const at = Number(op.row.created_at ?? 0);
      if (at <= closeStart || at > closeEnd) continue;
      if (op.tbl === 'payments') {
        pushedClosePayments.set(String(op.row.id), {
          id: String(op.row.id),
          device_id: deviceId,
          direction: String(op.row.direction),
          purpose: String(op.row.purpose),
          method: String(op.row.method),
          amount: Number(op.row.amount),
          created_at: at,
        });
      } else if (op.tbl === 'cash_moves') {
        pushedCloseCashMoves.set(String(op.row.id), {
          id: String(op.row.id),
          device_id: deviceId,
          kind: String(op.row.kind),
          amount: Number(op.row.amount),
          created_at: at,
        });
      } else if (op.tbl === 'expenses') {
        pushedCloseExpenses.set(String(op.row.id), {
          id: String(op.row.id),
          device_id: deviceId,
          amount: Number(op.row.amount),
          method: String(op.row.method),
          reverses_id:
            typeof op.row.reverses_id === 'string' ? op.row.reverses_id : null,
          created_at: at,
        });
      }
    }
  }
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      'SELECT id, role, permissions_json, max_discount_bp, active, deleted_at, created_at, updated_at, rev FROM staff WHERE tenant_id = ?1',
    ),
    db.prepare('SELECT id, bill_prefix FROM branches WHERE tenant_id = ?1'),
  ];
  const kinds: Array<
    | { tbl: string }
    | { onHand: true }
    | { sales: true }
    | { refundUdhaar: true }
    | { payments: 'refund' | 'sret' | 'purchase' | 'sale' }
    | { ledger: true }
    | { purchaseLines: true }
    | { saleLineSale: true }
    | { voids: true }
    | { expenses: true }
    | { reversals: true }
    | { customers: true }
    | { suppliers: true }
    | { partyBalance: 'customer' | 'supplier' }
    | { saleProducts: true }
    | { lastClose: true }
    | { closePayments: true }
    | { closeCashMoves: true }
    | { closeExpenses: true }
    | { saleLines: true }
    | { saleMoved: true }
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
      `SELECT id, business_date, branch_id, customer_id, udhaar_amount, paid_total FROM sales WHERE tenant_id = ?1 AND id IN (${p})`,
    { sales: true },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT sale_id AS id, SUM(udhaar_part) AS n, SUM(amount) AS amount FROM refunds WHERE tenant_id = ?1 AND sale_id IN (${p}) GROUP BY sale_id`,
    { refundUdhaar: true },
  );
  chunked(
    refundLineIds,
    (p) =>
      `SELECT id, sale_id FROM sale_lines WHERE tenant_id = ?1 AND id IN (${p})`,
    { saleLineSale: true },
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
    purchaseIds,
    (p) =>
      `SELECT purchase_id AS id, direction, purpose, method, amount FROM payments WHERE tenant_id = ?1 AND purchase_id IN (${p})`,
    { payments: 'purchase' },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT sale_id AS id, direction, purpose, method, amount FROM payments WHERE tenant_id = ?1 AND sale_id IN (${p})`,
    { payments: 'sale' },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT id, sale_id, product_id, qty_milli FROM sale_lines WHERE tenant_id = ?1 AND sale_id IN (${p})`,
    { saleLines: true },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT ref_id AS sale_id, product_id, SUM(-qty_delta_milli) AS qty FROM stock_movements WHERE tenant_id = ?1 AND reason_code = 'sale' AND ref_id IN (${p}) AND qty_delta_milli < 0 GROUP BY ref_id, product_id`,
    { saleMoved: true },
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
  chunked(
    partyIds.customer,
    (p) => `SELECT id FROM customers WHERE tenant_id = ?1 AND id IN (${p})`,
    { customers: true },
  );
  chunked(
    partyIds.supplier,
    (p) => `SELECT id FROM suppliers WHERE tenant_id = ?1 AND id IN (${p})`,
    { suppliers: true },
  );
  for (const type of ['customer', 'supplier'] as const) {
    chunked(
      deleteParties[type],
      (p) =>
        `SELECT party_id AS id, COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE tenant_id = ?1 AND party_type = '${type}' AND party_id IN (${p}) GROUP BY party_id`,
      { partyBalance: type },
    );
  }
  chunked(
    saleProductIds,
    (p) =>
      `SELECT id, price, track_stock, updated_at FROM products WHERE tenant_id = ?1 AND id IN (${p})`,
    { saleProducts: true },
  );
  chunked(
    closeDevices,
    (p) =>
      `SELECT device_id AS id, (SELECT d2.id FROM day_closes d2 WHERE d2.tenant_id = ?1 AND d2.device_id = d.device_id ORDER BY d2.period_end DESC LIMIT 1) AS close_id, MAX(period_end) AS period_end, (SELECT d2.counted_cash FROM day_closes d2 WHERE d2.tenant_id = ?1 AND d2.device_id = d.device_id ORDER BY d2.period_end DESC LIMIT 1) AS counted_cash FROM day_closes d WHERE d.tenant_id = ?1 AND d.device_id IN (${p}) GROUP BY d.device_id`,
    { lastClose: true },
  );
  const closeList = [...closeDevices];
  if (
    closeList.length > 0 &&
    Number.isFinite(closeStart) &&
    Number.isFinite(closeEnd)
  ) {
    for (let i = 0; i < closeList.length; i += 90) {
      const chunk = closeList.slice(i, i + 90);
      const params = chunk.map((_, j) => `?${j + 4}`).join(', ');
      stmts.push(
        db.prepare(
          `SELECT id, device_id, direction, purpose, method, amount, created_at FROM payments WHERE tenant_id = ?1 AND created_at > ?2 AND created_at <= ?3 AND device_id IN (${params})`,
          closeStart,
          closeEnd,
          ...chunk,
        ),
      );
      kinds.push({ closePayments: true });
      stmts.push(
        db.prepare(
          `SELECT id, device_id, kind, amount, created_at FROM cash_moves WHERE tenant_id = ?1 AND created_at > ?2 AND created_at <= ?3 AND device_id IN (${params})`,
          closeStart,
          closeEnd,
          ...chunk,
        ),
      );
      kinds.push({ closeCashMoves: true });
      stmts.push(
        db.prepare(
          `SELECT id, device_id, amount, method, reverses_id, created_at FROM expenses WHERE tenant_id = ?1 AND created_at > ?2 AND created_at <= ?3 AND device_id IN (${params})`,
          closeStart,
          closeEnd,
          ...chunk,
        ),
      );
      kinds.push({ closeExpenses: true });
    }
  }
  ctx.budget.take();
  const res = await db.batch(stmts);
  ctx.budget.take();
  const shop = await db.first<ShopRules>(
    'SELECT tax_rate_bp, tax_mode, round_total_to, default_credit_limit, updated_at FROM shop WHERE tenant_id = ?1',
  );
  const look: Lookups = {
    sales: new Map(),
    pushedSales,
    refundUdhaar: new Map(),
    refundAmount: new Map(),
    pushedRefundBefore,
    pushedRefundAmountBefore,
    existingVoids: new Set(),
    linkedPayments: new Map(),
    linkedLedger: new Map(),
    purchaseLineSupplier: new Map(),
    saleLineSale: new Map(),
    saleLinesBySale: new Map(),
    saleLineById: new Map(),
    saleMoved: new Map(),
    customers: new Set(),
    suppliers: new Set(),
    staff: new Map(),
    branches: new Map(),
    current: new Map(),
    existingLedger: new Set(),
    onHand: new Map(),
    expenses: new Map(),
    existingReversals: new Set(),
    pushedCreates: new Set(),
    shop,
    partyBalances: new Map(),
    products: new Map(),
    lastClose: new Map(),
    pushedCloses,
    closePayments: new Map(pushedClosePayments),
    closeCashMoves: new Map(pushedCloseCashMoves),
    closeExpenses: new Map(pushedCloseExpenses),
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
          branch_id: String(r.branch_id),
          customer_id: typeof r.customer_id === 'string' ? r.customer_id : null,
          udhaar_amount: Number(r.udhaar_amount ?? 0),
          paid_total: Number(r.paid_total ?? 0),
        });
      } else if ('refundUdhaar' in k) {
        look.refundUdhaar.set(String(r.id), Number(r.n ?? 0));
        look.refundAmount.set(String(r.id), Number(r.amount ?? 0));
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
      } else if ('saleLineSale' in k) {
        look.saleLineSale.set(String(r.id), String(r.sale_id));
      } else if ('saleLines' in k) {
        const saleId = String(r.sale_id);
        const line = {
          id: String(r.id),
          product_id: typeof r.product_id === 'string' ? r.product_id : null,
          qty_milli: Number(r.qty_milli),
        };
        const list = look.saleLinesBySale.get(saleId) ?? [];
        list.push(line);
        look.saleLinesBySale.set(saleId, list);
        look.saleLineById.set(line.id, {
          sale_id: saleId,
          product_id: line.product_id,
          qty_milli: line.qty_milli,
        });
      } else if ('saleMoved' in k) {
        const saleId = String(r.sale_id);
        const moved = look.saleMoved.get(saleId) ?? new Map<string, number>();
        moved.set(String(r.product_id), Number(r.qty ?? 0));
        look.saleMoved.set(saleId, moved);
      } else if ('customers' in k) {
        look.customers.add(String(r.id));
      } else if ('suppliers' in k) {
        look.suppliers.add(String(r.id));
      } else if ('partyBalance' in k) {
        look.partyBalances.set(
          key(k.partyBalance, String(r.id)),
          Number(r.n ?? 0),
        );
      } else if ('saleProducts' in k) {
        look.products.set(String(r.id), {
          price: Number(r.price ?? 0),
          track_stock: Number(r.track_stock ?? 0),
          updated_at: Number(r.updated_at ?? 0),
        });
      } else if ('lastClose' in k) {
        look.lastClose.set(String(r.id), {
          id: String(r.close_id ?? ''),
          period_end: Number(r.period_end ?? 0),
          counted_cash: Number(r.counted_cash ?? 0),
        });
      } else if ('closePayments' in k) {
        look.closePayments.set(String(r.id), {
          id: String(r.id),
          device_id: String(r.device_id),
          direction: String(r.direction),
          purpose: String(r.purpose),
          method: String(r.method),
          amount: Number(r.amount),
          created_at: Number(r.created_at),
        });
      } else if ('closeCashMoves' in k) {
        look.closeCashMoves.set(String(r.id), {
          id: String(r.id),
          device_id: String(r.device_id),
          kind: String(r.kind),
          amount: Number(r.amount),
          created_at: Number(r.created_at),
        });
      } else if ('closeExpenses' in k) {
        look.closeExpenses.set(String(r.id), {
          id: String(r.id),
          device_id: String(r.device_id),
          amount: Number(r.amount),
          method: String(r.method),
          reverses_id: typeof r.reverses_id === 'string' ? r.reverses_id : null,
          created_at: Number(r.created_at),
        });
      } else {
        look.onHand.set(String(r.id), {
          on_hand: Number(r.on_hand),
          avg_cost: Number(r.avg_cost),
        });
      }
    }
  });
  // A customer/supplier or branch created earlier in this push is not in D1 yet. Treat it
  // as existing so an offline "new parent, then sale/payment" batch is not rejected before
  // the parent row is applied (the batch orders parents first).
  for (const op of ops) {
    if (op.kind === 'delete' || typeof op.row?.id !== 'string') continue;
    if (op.kind === 'upsert' && (op.base_rev ?? 0) === 0)
      look.pushedCreates.add(key(op.tbl, op.row.id));
    if (op.tbl === 'customers') look.customers.add(op.row.id);
    if (op.tbl === 'suppliers') look.suppliers.add(op.row.id);
    if (op.tbl === 'branches' && !look.branches.has(op.row.id))
      look.branches.set(op.row.id, {
        bill_prefix: String(op.row.bill_prefix ?? ''),
      });
  }
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
  // Two inserts for the same ledger row id must never be summed by the document checks
  // while only one row is stored (a payment, line or stock movement could then be
  // half-recorded). Master rows are different: the same row can be edited several times
  // offline, each edit its own transaction, and those must apply in order.
  const rowSeen = new Set<string>();
  const duplicateRows = new Set<string>();
  for (const op of fresh) {
    if (op.kind !== 'insert' || !isLedgerTable(op.tbl)) continue;
    const rowKey = opRowKey(op);
    if (rowKey === null) continue;
    if (rowSeen.has(rowKey)) duplicateRows.add(rowKey);
    else rowSeen.add(rowKey);
  }

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
      const duplicate = ops.some((op) => {
        const rowKey = opRowKey(op);
        return rowKey !== null && duplicateRows.has(rowKey);
      });
      if (duplicate) {
        for (const op of ops) rejected.push({ op, code: 'CONSTRAINT_FAILED' });
        continue;
      }
      // Plan against a copy so a rejected transaction cannot advance the running
      // weighted-average state used by later transactions.
      const groupAvg = new Map(
        [...avg].map(([id, value]) => [id, { ...value }]),
      );
      try {
        const planned = ops.map((op) => planOp(ctx, look, ops, op, groupAvg));
        // A stored parent must not receive new children from a duplicate row. If every
        // insert in the transaction already exists this is a true replay (no side effects);
        // a mixture is a forged/invalid document and is rejected as a whole.
        const existing = planned.filter((p) => p.existingInsert).length;
        if (existing > 0 && existing < planned.length)
          throw new Reject('CONSTRAINT_FAILED');
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
          // A rejected stock-bearing document (or a server-repaired movement) can change
          // the on-hand/average state later groups were planned with. A master-only
          // failure can keep bisecting safely.
          if (
            g?.planned.some(
              (p) =>
                p.op.tbl === 'stock_movements' ||
                p.op.tbl === 'sales' ||
                p.op.tbl === 'purchases' ||
                p.op.tbl === 'supplier_returns' ||
                p.op.tbl === 'refunds' ||
                p.op.tbl === 'sale_voids',
            )
          )
            throw new StopExecution();
          return;
        }
        const mid = Math.ceil(list.length / 2);
        await run(list.slice(0, mid));
        await run(list.slice(mid));
      }
    };
    try {
      await run(groups);
    } catch (error) {
      if (!(error instanceof StopExecution)) throw error;
    }
    // Ops not applied, rejected or lost (budget, or groups after a D1 rejection) must be
    // planned again next round, in their original order. In particular, a group after a
    // rejected costed movement must not keep the phantom average it was planned with.
    const lostIds = new Set(lost.flat().map((op) => op.op_id));
    const handled = new Set<string>([
      ...final.keys(),
      ...rejected.map(({ op }) => op.op_id),
      ...lostIds,
    ]);
    const nextOps: PushOp[] = [];
    for (const group of groups) {
      for (const planned of group.planned) {
        const opId = planned.op.op_id;
        if (lostIds.has(opId) || !handled.has(opId)) nextOps.push(planned.op);
      }
    }
    pending = groupByTx(nextOps);
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

/**
 * Shared types and helpers for `applyOps` (03 §4.1).
 * Split out of applyOps.ts so write-rule checks and the apply engine can live apart.
 */
/**
 * Push algorithm (03 §4.1). Every statement is tenant-scoped through `tenantDb`. Ops are grouped
 * by `tx_id` (one user action); a group is applied or rejected as a whole (D-104).
 */
import { can, type Permission, type Role } from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import type { SqlValue, TenantDb } from '../db/tenantDb.ts';
import type { DeviceRow, TenantRow } from '../types.ts';
import type { OpResult, PushOp } from './opSchema.ts';
import { columnsOf, rowJsonExpr } from './tables.ts';

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

export const COLUMN = /^[a-z_][a-z0-9_]*$/u;
export const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const NEVER_FROM_CLIENT = new Set(['tenant_id', 'rev']);

export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !BUSINESS_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

/** Audit actions a till may write; operator/tenant lifecycle rows are server-only. */
export const CLIENT_AUDIT_ACTIONS = new Set([
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
  'sale_backdated',
  'shop_change',
  'staff_change',
  'stock_count',
  'supplier_return',
  'sync_ops_discarded',
  'void',
]);
export const SERVER_MANAGED: Partial<Record<string, ReadonlySet<string>>> = {
  products: new Set(['avg_cost']),
  sales: new Set(['status']),
};
export const DAY_MS = 86_400_000;
/** The row and its outbox envelope are written in the same action; a large skew means a forged or broken clock. */
export const MAX_ROW_OP_SKEW_MS = 10 * 60_000;

export type CostState = {
  on_hand: number;
  avg_cost: number;
  last_cost: number;
  /** When a costed movement last changed the cost (client action time). */
  cost_changed_at: number;
  /** The state includes a costed movement planned in this push. */
  pushed: boolean;
};

export type StaffRow = {
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

export type ShopRules = {
  tax_rate_bp: number;
  tax_mode: 'exclusive' | 'inclusive';
  cost_method: 'avg' | 'last';
  round_total_to: number;
  default_credit_limit: number | null;
  timezone: string;
  updated_at: number;
};
export type Current = {
  id: string;
  rev: number;
  deleted_at: number | null;
  setup_completed_at?: number | null;
  hard_limit?: number | null;
};

/** Statements of one op and the index of its guarded write (changes must be 1). */
export type Planned = {
  op: PushOp;
  stmts: D1PreparedStatement[];
  result: OpResult;
  guard: number | null;
  /** The insert targets a row id that already exists in D1. */
  existingInsert?: boolean;
};

export type Group = { txId: string; planned: Planned[] };

export type Lookups = {
  staff: Map<string, StaffRow>;
  branches: Map<string, { bill_prefix: string }>;
  current: Map<string, Current>;
  /** Ledger rows already stored (append-only tables have no rev column). */
  existingLedger: Set<string>;
  onHand: Map<string, CostState>;
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
  /** Party id → deleted_at (null = live), for "new business needs a live party" checks. */
  partyDeleted: Map<string, number | null>;
  /** Original expenses referenced by a reversal row in this push. */
  expenses: Map<
    string,
    {
      amount: number;
      method: string;
      reverses_id: string | null;
      business_date: string;
    }
  >;
  /** Expense ids that already have a stored reversal. */
  existingReversals: Set<string>;
  /** Master rows created earlier in this push (`base_rev = 0`), for create-then-delete. */
  pushedCreates: Set<string>;
  /** Current shop policy (tax, rounding, default limits). */
  shop: ShopRules | null;
  /** Stored ledger balance for a party being checked or deleted. */
  partyBalances: Map<string, number>;
  /** Current product price/cost/tracking, for sale price and cost checks. */
  products: Map<
    string,
    {
      price: number;
      avg_cost: number;
      last_cost: number;
      track_stock: number;
      updated_at: number;
    }
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

export type ClosePayment = {
  id: string;
  device_id: string;
  direction: string;
  purpose: string;
  method: string;
  amount: number;
  created_at: number;
};
export type CloseCashMove = {
  id: string;
  device_id: string;
  kind: string;
  amount: number;
  created_at: number;
};
export type CloseExpense = {
  id: string;
  device_id: string;
  amount: number;
  method: string;
  reverses_id: string | null;
  created_at: number;
};

export type SaleInfo = {
  business_date: string;
  branch_id: string;
  customer_id: string | null;
  udhaar_amount: number;
  paid_total: number;
};
export type LinkedPayment = {
  direction: string;
  purpose: string;
  method: string;
  amount: number;
};
export type LinkedLedger = {
  party_type: string;
  party_id: string;
  amount: number;
};

export const key = (tbl: string, id: string) => `${tbl}:${id}`;

/** Stable row identity of an op, used to detect duplicate row ids in one push. */
export function opRowKey(op: PushOp): string | null {
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

export function isD1ConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint failed|cannot store|datatype mismatch|SQLITE_CONSTRAINT|SQLITE_MISMATCH|too many|no such column|has no column/iu.test(
    message,
  );
}

export function sqlValue(v: unknown): SqlValue {
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

export function changeLog(
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

export function appliedOp(
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

export class Reject extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** A D1-level rejection stops the rest of this round: later groups were planned against a
 * weighted-average state that included the rejected group, so they must be planned again
 * (or deferred to the client) instead of being applied with a phantom average. */
export class StopExecution extends Error {}

export function overrideFor(
  group: PushOp[],
  entity: string,
  entityId: string,
  permission: Permission,
  staff: Map<string, StaffRow>,
  roles: readonly Role[] = ['owner', 'manager', 'cashier'],
  options: { excludeStaffId?: string; minDiscountBp?: number } = {},
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
      if (
        options.excludeStaffId !== undefined &&
        after.approved_by === options.excludeStaffId
      )
        return false;
      if (
        options.minDiscountBp !== undefined &&
        approver &&
        approver.role !== 'owner' &&
        Number(approver.max_discount_bp ?? 0) < options.minDiscountBp
      )
        return false;
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
export function overrideForLine(
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
export function staffCreatedInGroup(
  group: PushOp[],
  id: string,
): StaffRow | null {
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
export function bootstrapOwnerId(
  look: Lookups,
  group: PushOp[],
): string | null {
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
export function groupStaffAuthorized(
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

export function staffOf(
  look: Lookups,
  group: PushOp[],
  id: unknown,
): StaffRow | null {
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
export function staffForHistory(
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
export function effectiveStaff(
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
  // A soft-deleted row cannot be resurrected by an upsert (D-104 / 03 §5). This is
  // also what planOp writes, so the owner-count check must model it too.
  if (current.deleted_at !== null) {
    return {
      role: current.role,
      active: current.active,
      deleted_at: current.deleted_at,
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
export function ownersAfterPush(look: Lookups, group: PushOp[]): Set<string> {
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

export function assertOwnerRemains(look: Lookups, group: PushOp[]): void {
  if (ownersAfterPush(look, group).size === 0)
    throw new Reject('CONSTRAINT_FAILED');
}

/** Only demoting/deactivating/deleting a stored owner can remove the last owner. */
export function removesOwner(look: Lookups, op: PushOp): boolean {
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

export function partyExists(
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

/** A party may be used by a new row only if it was not already deleted at that time. */
export function partyUsableAt(
  look: Lookups,
  group: PushOp[],
  type: 'customer' | 'supplier',
  id: unknown,
  at: unknown,
): boolean {
  // Unknown and another tenant's ids are indistinguishable (no existence oracle) and
  // keep the FOREIGN_KEY answer the foreign key used to give them. A soft-deleted
  // party is a constraint failure, not a missing row.
  if (!partyExists(look, group, type, id)) throw new Reject('FOREIGN_KEY');
  if (typeof id !== 'string') return false;
  const deleted = look.partyDeleted.get(key(type, id));
  if (deleted !== undefined)
    return deleted === null || (typeof at === 'number' && at <= deleted);
  const table = type === 'customer' ? 'customers' : 'suppliers';
  const op = group.find(
    (candidate) =>
      candidate.tbl === table &&
      candidate.kind !== 'delete' &&
      candidate.row?.id === id,
  );
  if (!op) return false;
  const rowDeleted = op.row?.deleted_at;
  return (
    rowDeleted === null ||
    rowDeleted === undefined ||
    (typeof at === 'number' && at <= Number(rowDeleted))
  );
}

export function saleOf(
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
export function linkedInGroup(
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

export function asPayment(p: Record<string, unknown>): LinkedPayment {
  return {
    direction: String(p.direction),
    purpose: String(p.purpose),
    method: String(p.method),
    amount: Number(p.amount),
  };
}

/** Exactly one payment, with this direction/purpose/method/amount (04 §5). */
export function onePayment(
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

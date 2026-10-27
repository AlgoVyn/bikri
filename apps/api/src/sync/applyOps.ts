/**
 * Push algorithm (03 §4.1). Every statement is tenant-scoped through `tenantDb`. Ops are grouped
 * by `tx_id` (one user action); a group is applied or rejected as a whole (D-104).
 */
import {
  can,
  isLedgerTable,
  isMasterTable,
  movementChangesAvgCost,
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
  onHand: Map<string, { on_hand: number; avg_cost: number }>;
  /** business_date of sales that pushed voids refer to (manager same-day voids, D-044). */
  saleDates: Map<string, string>;
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

function staffOf(look: Lookups, group: PushOp[], id: unknown): StaffRow | null {
  if (typeof id !== 'string') return null;
  const s = look.staff.get(id) ?? staffCreatedInGroup(group, id);
  return s && s.active === 1 && s.deleted_at === null ? s : null;
}

/** Server-side checks beyond the database constraints (04 §5, 05 §5). Throws Reject. */
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
        const branch = look.branches.get(String(row.branch_id));
        const expected = branch
          ? `${branch.bill_prefix}-${ctx.device.device_code}-${String(row.invoice_seq)}`
          : null;
        if (row.invoice_no !== expected) throw new Reject('CONSTRAINT_FAILED');
        break;
      }
      case 'refunds':
        if (
          !allowed('refund.create') &&
          !overrideFor(group, 'refunds', row.id, 'refund.create', look.staff)
        )
          throw new Reject('FORBIDDEN');
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
          const saleDate =
            group.find((o) => o.tbl === 'sales' && o.row?.id === saleId)?.row
              ?.business_date ?? look.saleDates.get(saleId);
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
        );
        if (!allowed('expense.create') && !over) throw new Reject('FORBIDDEN');
        if (staff?.role === 'cashier' && !over) {
          if (row.method !== 'cash' || Number(row.amount) > 200_000)
            throw new Reject('FORBIDDEN');
        }
        break;
      }
      case 'supplier_returns':
        if (!allowed('purchase.create')) throw new Reject('FORBIDDEN');
        break;
      default:
        break;
    }
    return;
  }

  // upsert (master)
  const updater = staffOf(look, group, row.updated_by);
  if (op.tbl === 'staff' || op.tbl === 'branches' || op.tbl === 'shop') {
    // The setup wizard creates the first owner together with the shop (no owner exists yet).
    const firstOwner =
      updater?.role === 'owner' &&
      [...look.staff.values()].every(
        (s) => s.role !== 'owner' || s.deleted_at !== null,
      );
    if (updater?.role !== 'owner' && !firstOwner) throw new Reject('FORBIDDEN');
  }
  if (op.tbl === 'shop') {
    const cur = look.current.get(key('shop', 'shop'));
    if ((op.base_rev ?? 0) === 0 && cur?.setup_completed_at)
      throw new Reject('SETUP_ALREADY_DONE');
  }
  if (op.tbl === 'products') {
    const fields =
      op.base_rev === 0 ? Object.keys(row) : (op.changed_fields ?? []);
    if (
      fields.includes('price') &&
      !(updater && can(updater.role, updater.permissions_json, 'catalog.edit'))
    )
      throw new Reject('FORBIDDEN');
    if (
      fields.includes('last_cost') &&
      !(
        updater &&
        (can(updater.role, updater.permissions_json, 'catalog.edit') ||
          can(updater.role, updater.permissions_json, 'purchase.create'))
      )
    )
      throw new Reject('FORBIDDEN');
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
        state.avg_cost = nextAvgCost({
          on_hand_milli: state.on_hand,
          avg_cost: state.avg_cost,
          qty_milli: qty,
          unit_cost: Number(row.unit_cost),
        });
        out.push(
          db.prepare(
            'UPDATE products SET avg_cost = ?2 WHERE tenant_id = ?1 AND id = ?3 AND avg_cost <> ?2',
            state.avg_cost,
            row.product_id,
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
  const products = new Set<string>();
  const voidedSales = new Set<string>();
  for (const op of ops) {
    if (op.tbl === 'sale_voids' && typeof op.row?.sale_id === 'string')
      voidedSales.add(op.row.sale_id);
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
    if (op.tbl === 'stock_movements' && typeof op.row?.product_id === 'string')
      products.add(op.row.product_id);
  }
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      'SELECT id, role, permissions_json, active, deleted_at FROM staff WHERE tenant_id = ?1',
    ),
    db.prepare('SELECT id, bill_prefix FROM branches WHERE tenant_id = ?1'),
  ];
  const kinds: Array<{ tbl: string } | { onHand: true } | { sales: true }> = [];
  for (const [tbl, ids] of byTable) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const extra = tbl === 'shop' ? ', setup_completed_at' : '';
      stmts.push(
        db.prepare(
          `SELECT id, rev, deleted_at${extra} FROM ${tbl} WHERE tenant_id = ?1 AND id IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
          ...chunk,
        ),
      );
      kinds.push({ tbl });
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
  const saleList = [...voidedSales];
  for (let i = 0; i < saleList.length; i += 90) {
    const chunk = saleList.slice(i, i + 90);
    stmts.push(
      db.prepare(
        `SELECT id, business_date FROM sales WHERE tenant_id = ?1 AND id IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
        ...chunk,
      ),
    );
    kinds.push({ sales: true });
  }
  ctx.budget.take();
  const res = await db.batch(stmts);
  const look: Lookups = {
    saleDates: new Map(),
    staff: new Map(),
    branches: new Map(),
    current: new Map(),
    onHand: new Map(),
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
      if ('tbl' in k) {
        look.current.set(key(k.tbl, String(r.id)), {
          id: String(r.id),
          rev: Number(r.rev),
          deleted_at: (r.deleted_at as number | null) ?? null,
          setup_completed_at:
            (r.setup_completed_at as number | null | undefined) ?? null,
        });
      } else if ('sales' in k) {
        look.saleDates.set(String(r.id), String(r.business_date));
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

    const groups: Group[] = [];
    for (const ops of pending) {
      try {
        groups.push({
          txId: ops[0]?.tx_id ?? '',
          planned: ops.map((op) => planOp(ctx, look, ops, op, avg)),
        });
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

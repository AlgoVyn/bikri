/**
 * Push algorithm (03 §4.1). Every statement is tenant-scoped through `tenantDb`. Ops are grouped
 * by `tx_id` (one user action); a group is applied or rejected as a whole (D-104).
 * Write-rule checks live in `applyOpsCheck.ts`/`checks/`; server-authored stock and
 * money rows live in `applyOpsServerRows.ts`; shared types/helpers in `applyOpsShared.ts`.
 */
import { isLedgerTable, isMasterTable, newId, type Role } from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import { checkOp } from './applyOpsCheck.ts';
import { applyCloseChanges, loadLookups } from './applyOpsLookups.ts';
import {
  moneyAuditStatements,
  sideEffects,
  stockRepairStatements,
} from './applyOpsServerRows.ts';
import {
  type ApplyContext,
  type ApplyOutcome,
  appliedOp,
  type CostMap,
  type CostState,
  changeLog,
  errorCodeOf,
  type Group,
  guardAssert,
  isD1ConstraintError,
  isGuardAssertion,
  key,
  type Lookups,
  opRowKey,
  ownersAddedInGroup,
  type Planned,
  Reject,
  removesOwner,
  type ShopRules,
  type StaffRow,
  StopExecution,
  sqlValue,
  writableColumns,
} from './applyOpsShared.ts';
import type { OpResult, PushOp } from './opSchema.ts';
import { applyRank } from './tables.ts';

export type { ApplyContext, ApplyOutcome } from './applyOpsShared.ts';
export {
  CallBudget,
  errorCodeOf,
  MAX_D1_CALLS,
  MAX_ROW_OP_SKEW_MS,
  writableColumns,
} from './applyOpsShared.ts';

/**
 * Copy-on-write view of the running avg-cost state for one transaction group. Planning
 * reads and mutates product state in place; cloning the whole map per group made a push
 * O(groups × products). Only states the group actually touches are copied, so a rejected
 * group rolls back by dropping its overlay and a commit is O(touched).
 */
class CostOverlay implements CostMap {
  private readonly base: Map<string, CostState>;
  private readonly touched = new Map<string, CostState>();
  constructor(base: Map<string, CostState>) {
    this.base = base;
  }
  get(id: string): CostState | undefined {
    const current = this.touched.get(id);
    if (current !== undefined) return current;
    const stored = this.base.get(id);
    if (stored === undefined) return undefined;
    const copy = { ...stored };
    this.touched.set(id, copy);
    return copy;
  }
  set(id: string, value: CostState): void {
    this.touched.set(id, value);
  }
  has(id: string): boolean {
    return this.touched.has(id) || this.base.has(id);
  }
  commit(): void {
    for (const [id, value] of this.touched) this.base.set(id, value);
  }
}

/** Builds the statements of one op (03 §4.1 step 4). Throws Reject for checks it can do. */
function planOp(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  avg: CostMap,
): Planned {
  const { db, now } = ctx;
  const deviceId = ctx.device.id;
  checkOp(ctx, look, group, op, avg);
  const tbl = op.tbl as D1Table;

  if (op.kind === 'delete') {
    const id = op.row_id ?? '';
    // Defence in depth for the last-owner invariant (API-H1): even a planning bug must
    // not let a 0-row guard commit a shop with no active owner. Mirrors LAST_ADMIN_DEVICE.
    // A promotion written later in the same batch counts too, so an owner transfer is not
    // blocked by the promote statement's position.
    const addedOwners = removesOwner(look, op)
      ? ownersAddedInGroup(look, group, op)
      : 0;
    const ownerGuard =
      tbl === 'staff' && removesOwner(look, op)
        ? ` AND ((SELECT COUNT(*) FROM staff WHERE tenant_id = ?1 AND id <> ?4 AND role = 'owner' AND active = 1 AND deleted_at IS NULL) + ${addedOwners}) > 0`
        : '';
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
              `UPDATE ${tbl} SET deleted_at = ?2, updated_at = ?2, updated_by = ?3, rev = rev + 1 WHERE tenant_id = ?1 AND id = ?4 AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM applied_ops WHERE tenant_id = ?1 AND op_id = ?5)`,
              now,
              op.updated_by ?? null,
              id,
              op.op_id,
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
          `UPDATE ${tbl} SET deleted_at = ?2, updated_at = ?2, updated_by = ?3, rev = rev + 1 WHERE tenant_id = ?1 AND id = ?4 AND rev = ?5 AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM applied_ops WHERE tenant_id = ?1 AND op_id = ?6)${ownerGuard}`,
          now,
          op.updated_by ?? null,
          id,
          cur.rev,
          op.op_id,
        ),
        guardAssert(db),
        appliedOp(db, op, deviceId, now, 'applied', null, true),
        changeLog(db, tbl, id, 'delete', deviceId, now, true),
      ],
      result: { op_id: op.op_id, result: 'applied', server_rev: cur.rev + 1 },
      guard: 0,
    };
  }

  const row = op.row ?? {};
  const id = String(row.id);
  // Older tills do not send the denormalised date; derive it from the parent sale so
  // their lines still join date-range reports after they update (D-228).
  if (
    tbl === 'sale_lines' &&
    op.kind === 'insert' &&
    (typeof row.business_date !== 'string' || row.business_date === '')
  ) {
    const saleId = typeof row.sale_id === 'string' ? row.sale_id : '';
    const parent =
      group.find(
        (candidate) =>
          candidate.tbl === 'sales' &&
          candidate.kind !== 'delete' &&
          candidate.row?.id === saleId,
      )?.row ??
      look.sales.get(saleId) ??
      look.pushedSales.get(saleId);
    if (parent && typeof parent.business_date === 'string')
      row.business_date = parent.business_date;
  }
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
      // `applied_ops` handles a replay of the same op id; a fresh op id is allowed only
      // when it is the same stored void row (restore recovery / pruned applied_ops).
      const replay = look.existingLedger.has(key('sale_voids', id));
      if (!replay && (look.existingVoids.has(saleId) || duplicateInGroup))
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
    const insertCols = [...cols];
    const insertValues = cols.map((c) => sqlValue(row[c]));
    // `avg_cost` is server-managed, but a product with a catalogue cost and no stock
    // movement must still start from that cost; otherwise every offline sale before the
    // first costed movement is rejected and later profit uses zero (07 §7).
    if (tbl === 'products' && !insertCols.includes('avg_cost')) {
      insertCols.push('avg_cost');
      insertValues.push(sqlValue(Number(row.last_cost ?? 0)));
    }
    const stmts = [
      db.prepare(
        `INSERT INTO ${tbl} (tenant_id, id${insertCols.map((c) => `, ${c}`).join('')}) VALUES (?1, ?2${insertCols.map((_, i) => `, ?${i + 3}`).join('')}) ON CONFLICT (tenant_id, id) DO NOTHING`,
        id,
        ...insertValues,
      ),
      changeLog(db, tbl, id, 'upsert', deviceId, now, true),
      ...sideEffects(ctx, tbl, row, avg, group, op.op_id),
    ];
    if (
      tbl === 'sales' ||
      tbl === 'purchases' ||
      tbl === 'supplier_returns' ||
      tbl === 'refunds' ||
      tbl === 'sale_voids'
    )
      stmts.push(
        ...stockRepairStatements(ctx, look, group, tbl, row, avg, op.op_id),
      );
    if (
      tbl === 'refunds' ||
      tbl === 'sale_voids' ||
      tbl === 'supplier_returns' ||
      tbl === 'day_closes'
    )
      stmts.push(...moneyAuditStatements(ctx, group, tbl, row, op.op_id));
    // Last: the guards above look for a missing `applied_ops` row. Writing it first
    // would make every side effect skip itself in the request that is applying the op.
    stmts.push(appliedOp(db, op, deviceId, now, 'applied', null, false));
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
    const insertCols = [...cols];
    const insertValues = cols.map((c) => sqlValue(row[c]));
    if (tbl === 'products' && !insertCols.includes('avg_cost')) {
      insertCols.push('avg_cost');
      insertValues.push(sqlValue(Number(row.last_cost ?? 0)));
    }
    return {
      op,
      stmts: [
        db.prepare(
          `INSERT INTO ${tbl} (tenant_id, id${insertCols.map((c) => `, ${c}`).join('')}, rev) VALUES (?1, ?2${insertCols.map((_, i) => `, ?${i + 3}`).join('')}, 1) ON CONFLICT (tenant_id, id) DO NOTHING`,
          id,
          ...insertValues,
        ),
        guardAssert(db),
        appliedOp(db, op, deviceId, now, 'applied', null, true),
        changeLog(db, tbl, id, 'upsert', deviceId, now, true),
      ],
      result: { op_id: op.op_id, result: 'applied', server_rev: 1 },
      guard: 0,
    };
  }
  const merge = cur.rev !== (op.base_rev ?? 0);
  const changed = new Set(op.changed_fields ?? []);
  // The op's changed_fields is the authorisation and write list. The row payload is a
  // full local row, so writing every supplied column here would let a permitted
  // last_cost update smuggle in a price/track_stock change (see costSource).
  let set = cols.filter(
    (c) => changed.has(c) || c === 'updated_at' || c === 'updated_by',
  );
  // A delete always wins over a concurrent edit (03 §5).
  if (cur.deleted_at !== null) set = set.filter((c) => c !== 'deleted_at');
  const assignments = [
    ...set.map((c, i) => `${c} = ?${i + 4}`),
    'rev = rev + 1',
  ].join(', ');
  const guardParam = set.length + 4;
  const addedOwners = removesOwner(look, op)
    ? ownersAddedInGroup(look, group, op)
    : 0;
  const ownerGuard =
    tbl === 'staff' && removesOwner(look, op)
      ? ` AND ((SELECT COUNT(*) FROM staff WHERE tenant_id = ?1 AND id <> ?2 AND role = 'owner' AND active = 1 AND deleted_at IS NULL) + ${addedOwners}) > 0`
      : '';
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE ${tbl} SET ${assignments} WHERE tenant_id = ?1 AND id = ?2 AND rev = ?3 AND NOT EXISTS (SELECT 1 FROM applied_ops WHERE tenant_id = ?1 AND op_id = ?${guardParam})${ownerGuard}`,
      id,
      cur.rev,
      ...set.map((c) => sqlValue(row[c])),
      op.op_id,
    ),
    guardAssert(db),
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

/** `applied_ops` answers for op ids already seen (chunks of 100 bound parameters). */
async function alreadyApplied(
  ctx: ApplyContext,
  ops: PushOp[],
): Promise<{ seen: Map<string, OpResult>; rowsRead: number }> {
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
  let rowsRead = res.reduce(
    (sum, result) => sum + (result.meta.rows_read ?? 0),
    0,
  );
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
  // A replayed `applied` op is what a till gets after a lost response. It must still learn
  // the row's current revision: otherwise it keeps `base_rev = 0`, and a later rejected edit
  // discarded in Settings → Sync would delete a row the server already has (03 §3, §5).
  const byTable = new Map<string, Set<string>>();
  for (const op of ops) {
    const answer = out.get(op.op_id);
    if (!answer || answer.result === 'rejected' || !isMasterTable(op.tbl))
      continue;
    const id =
      op.kind === 'delete' ? op.row_id : (op.row?.id as string | undefined);
    if (typeof id !== 'string' || id.length === 0) continue;
    const set = byTable.get(op.tbl) ?? new Set<string>();
    set.add(id);
    byTable.set(op.tbl, set);
  }
  if (byTable.size > 0) {
    const revStatements: D1PreparedStatement[] = [];
    const plans: Array<{ tbl: string; chunk: string[] }> = [];
    for (const [tbl, set] of byTable) {
      const list = [...set];
      for (let i = 0; i < list.length; i += 90) {
        const chunk = list.slice(i, i + 90);
        revStatements.push(
          ctx.db.prepare(
            `SELECT id, rev FROM ${tbl} WHERE tenant_id = ?1 AND id IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
            ...chunk,
          ),
        );
        plans.push({ tbl, chunk });
      }
    }
    ctx.budget.take();
    const revs = await ctx.db.batch(revStatements);
    rowsRead += revs.reduce(
      (sum, result) => sum + (result.meta.rows_read ?? 0),
      0,
    );
    const revOf = new Map<string, number>();
    revs.forEach((result, index) => {
      const plan = plans[index];
      if (!plan) return;
      for (const row of (result.results ?? []) as Array<{
        id: string;
        rev: number;
      }>)
        revOf.set(`${plan.tbl}:${row.id}`, Number(row.rev));
    });
    for (const op of ops) {
      const answer = out.get(op.op_id);
      if (!answer || answer.result === 'rejected' || !isMasterTable(op.tbl))
        continue;
      const id =
        op.kind === 'delete' ? op.row_id : (op.row?.id as string | undefined);
      if (typeof id !== 'string') continue;
      const rev = revOf.get(`${op.tbl}:${id}`);
      if (typeof rev === 'number' && Number.isSafeInteger(rev))
        out.set(op.op_id, { ...answer, server_rev: rev });
    }
  }
  return { seen: out, rowsRead };
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

/** Apply the product rows of a successfully planned transaction to the next group in order. */
/** Apply the ledger rows of a successfully planned transaction to later balance checks. */
function applyLedgerChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (op.tbl !== 'ledger_entries' || op.kind !== 'insert' || !op.row)
      continue;
    const type = op.row.party_type;
    if (type !== 'customer' && type !== 'supplier') continue;
    const id = String(op.row.party_id ?? '');
    const amount = Number(op.row.amount ?? 0);
    if (id === '' || !Number.isSafeInteger(amount)) continue;
    // A replay is already reflected in the stored tenant row loaded by loadLookups.
    if (look.existingLedger.has(key('ledger_entries', String(op.row.id ?? ''))))
      continue;
    const party = key(type, id);
    look.partyBalances.set(
      party,
      (look.partyBalances.get(party) ?? 0) + amount,
    );
  }
}

function applyProductChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (
      op.tbl !== 'products' ||
      op.kind === 'delete' ||
      typeof op.row?.id !== 'string'
    )
      continue;
    const previous = look.products.get(op.row.id);
    if (!previous) {
      look.products.set(op.row.id, {
        price: Number(op.row.price ?? 0),
        avg_cost: Number(op.row.last_cost ?? 0),
        last_cost: Number(op.row.last_cost ?? 0),
        track_stock: Number(op.row.track_stock ?? 0),
        updated_at: Number(op.row.updated_at ?? op.row.created_at ?? 0),
        kind: String(op.row.kind ?? 'simple'),
        pushed: true,
      });
      continue;
    }
    // planOp writes only `changed_fields` (plus updated_at/updated_by) for an existing
    // row. The in-memory state used by later transactions must follow the same list;
    // otherwise a permitted `last_cost` upsert could smuggle `price: 0` into a sale
    // later in the same push.
    const changed = new Set(op.changed_fields ?? []);
    const pick = <K extends keyof typeof previous>(field: K) =>
      changed.has(field) && op.row?.[field] !== undefined
        ? op.row[field]
        : previous[field];
    look.products.set(op.row.id, {
      price: Number(pick('price')),
      avg_cost: previous.avg_cost,
      last_cost: Number(pick('last_cost')),
      track_stock: Number(pick('track_stock')),
      updated_at: Number(op.row.updated_at ?? previous.updated_at),
      kind: String(pick('kind')),
      pushed: true,
    });
  }
}

/**
 * Apply the recipe rows of a successfully planned transaction to the next group (API-M2):
 * a bundle created or edited earlier in the same push must be visible to a later sale,
 * and a deleted/soft-deleted row must disappear from the active recipe.
 */
function applyBundleChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (op.tbl !== 'bundle_items') continue;
    const id = op.kind === 'delete' ? op.row_id : op.row?.id;
    if (typeof id !== 'string' || id === '') continue;
    const previous = look.bundleItemById.get(id);
    const previousRecipe = previous
      ? look.bundleRecipes.get(previous.bundle_id)
      : undefined;
    const previousRow = previousRecipe?.find((item) => item.id === id);
    const bundleId =
      typeof op.row?.bundle_id === 'string'
        ? op.row.bundle_id
        : previous?.bundle_id;
    const componentId =
      typeof op.row?.component_product_id === 'string'
        ? op.row.component_product_id
        : previous?.component_product_id;
    if (!bundleId || !componentId) continue;
    const deleted =
      op.kind === 'delete' ||
      (op.row?.deleted_at !== null && op.row?.deleted_at !== undefined);
    const recipe = (look.bundleRecipes.get(bundleId) ?? []).filter(
      (item) => item.id !== id,
    );
    if (deleted) {
      look.bundleItemById.delete(id);
      const usedBy = (look.bundleOfComponent.get(componentId) ?? []).filter(
        (candidate) => candidate !== bundleId,
      );
      if (usedBy.length > 0) look.bundleOfComponent.set(componentId, usedBy);
      else look.bundleOfComponent.delete(componentId);
      if (previousRow)
        recipe.push({
          ...previousRow,
          deleted_at: Number(op.row?.deleted_at ?? op.created_at ?? 0),
        });
    } else {
      if (!op.row) continue;
      recipe.push({
        id,
        component_product_id: componentId,
        qty_milli: Number(op.row.qty_milli ?? 0),
        sort_order: Number(op.row.sort_order ?? 0),
        updated_at: Number(op.row.updated_at ?? op.created_at ?? 0),
        deleted_at: null,
      });
      look.bundleItemById.set(id, {
        bundle_id: bundleId,
        component_product_id: componentId,
      });
      const usedBy = look.bundleOfComponent.get(componentId) ?? [];
      if (!usedBy.includes(bundleId)) {
        usedBy.push(bundleId);
        look.bundleOfComponent.set(componentId, usedBy);
      }
    }
    if (previous && previous.bundle_id !== bundleId) {
      const stale = (look.bundleRecipes.get(previous.bundle_id) ?? []).filter(
        (item) => item.id !== id,
      );
      look.bundleRecipes.set(previous.bundle_id, stale);
    }
    look.bundleRecipes.set(bundleId, recipe);
  }
}

/**
 * Apply a planned staff transaction to the in-memory state used by later transactions of
 * the same push. A new cashier created offline can ring a sale before reconnect; the sale
 * is a separate transaction, so the Worker must see the staff row that precedes it.
 * Soft-deleted rows are never resurrected (03 §5), matching planOp.
 */
function applyStaffChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (op.tbl !== 'staff') continue;
    const id = op.kind === 'delete' ? op.row_id : op.row?.id;
    if (typeof id !== 'string') continue;
    const current = look.staff.get(id);
    if (op.kind === 'delete') {
      if (!current) continue;
      const at = Number(op.created_at ?? current.updated_at);
      look.staff.set(id, {
        ...current,
        active: 0,
        deleted_at: at,
        updated_at: at,
        rev: current.rev + 1,
      });
      continue;
    }
    if (!op.row) continue;
    if (!current) {
      look.staff.set(id, {
        id,
        role: String(op.row.role ?? 'cashier') as Role,
        permissions_json: String(op.row.permissions_json ?? '{}'),
        max_discount_bp: Number(op.row.max_discount_bp ?? 0),
        active: Number(op.row.active ?? 1),
        deleted_at:
          op.row.deleted_at === null || op.row.deleted_at === undefined
            ? null
            : Number(op.row.deleted_at),
        created_at: Number(op.row.created_at ?? 0),
        updated_at: Number(op.row.updated_at ?? 0),
        rev: 1,
      });
      continue;
    }
    if (current.deleted_at !== null) continue;
    const changed = new Set(op.changed_fields ?? []);
    const pick = (field: keyof StaffRow): unknown => {
      const raw = op.row?.[field];
      // Match planOp: only the changed columns (plus its always-written updated_at)
      // reach D1. A field carried in the full client row but not in changed_fields
      // must not leak into later transactions of this push.
      if (field === 'updated_at' || changed.has(field))
        return raw === undefined ? current[field] : raw;
      return current[field];
    };
    const deleted = pick('deleted_at');
    look.staff.set(id, {
      ...current,
      role: String(pick('role') ?? current.role) as Role,
      permissions_json: String(pick('permissions_json') ?? '{}'),
      max_discount_bp: Number(pick('max_discount_bp') ?? 0),
      active: Number(pick('active') ?? 0),
      deleted_at:
        deleted === null || deleted === undefined ? null : Number(deleted),
      updated_at: Number(pick('updated_at') ?? current.updated_at),
      rev: current.rev + 1,
    });
  }
}

/** The shop settings a later transaction of the same push must see. */
function applyShopChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (op.tbl !== 'shop' || op.kind !== 'upsert' || !op.row) continue;
    const current = look.shop;
    const changed = new Set(op.changed_fields ?? []);
    const pick = (field: keyof ShopRules): unknown => {
      const raw = op.row?.[field];
      if (current === null) return raw;
      if (field === 'updated_at' || changed.has(field))
        return raw === undefined ? current[field] : raw;
      return current[field];
    };
    const taxMode = String(pick('tax_mode') ?? 'exclusive');
    const costMethod = String(pick('cost_method') ?? 'avg');
    const limit = pick('default_credit_limit');
    look.shop = {
      tax_rate_bp: Number(pick('tax_rate_bp') ?? 0),
      tax_mode: taxMode === 'inclusive' ? 'inclusive' : 'exclusive',
      cost_method: costMethod === 'last' ? 'last' : 'avg',
      round_total_to: Number(pick('round_total_to') ?? 1),
      default_credit_limit:
        limit === null || limit === undefined ? null : Number(limit),
      timezone: String(pick('timezone') ?? 'Asia/Karachi'),
      updated_at: Number(pick('updated_at') ?? 0),
    };
  }
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

  const applied = await alreadyApplied(ctx, ops);
  for (const [id, r] of applied.seen) final.set(id, r);
  rowsRead += applied.rowsRead;
  const fresh = ops.filter((o) => !applied.seen.has(o.op_id));
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
  // Transactions are planned and applied in push order (the outbox's `seq`). The till
  // writes a parent before any child that references it, so this is already parents-first
  // for the cases that matter (setup, restore recovery, a cashier created before selling).
  // Reordering whole transactions by table rank would break chronological cost validation:
  // a delivery rung before a sale is a later `tx_id`, but `purchases` ranks after `sales`,
  // so the sale would be checked against the pre-delivery average cost and rejected.
  // Foreign-key safety inside one request is provided by the statement sort in `run()` below.
  for (let round = 0; round < 2 && pending.length > 0; round += 1) {
    if (ctx.budget.used >= ctx.budget.max - 2) break;
    if (round > 0) {
      // A previous round lost a guarded write. The most likely cause is a concurrent
      // retry of the same op: it may have committed between our first `applied_ops`
      // read and the batch. Re-read before planning again, so a replay is answered
      // from `applied_ops` instead of being merged a second time.
      const again = await alreadyApplied(ctx, pending.flat());
      rowsRead += again.rowsRead;
      for (const [id, result] of again.seen) final.set(id, result);
      pending = pending
        .map((ops) => ops.filter((op) => !again.seen.has(op.op_id)))
        .filter((ops) => ops.length > 0);
      if (pending.length === 0) break;
    }
    const look = await loadLookups(ctx, pending.flat());
    rowsRead += look.rowsRead;
    const avg = new Map<string, CostState>();
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
        // A product created with a catalogue cost starts from that cost until the
        // first costed movement recomputes it.
        avg_cost: Number(op.row.last_cost ?? 0),
        last_cost: Number(op.row.last_cost ?? 0),
        cost_changed_at: Number(op.row.updated_at ?? op.row.created_at ?? 0),
        pushed: true,
      });
    }

    // A product with no stock movement yet still has a catalogue cost snapshot.
    for (const [id, product] of look.products) {
      if (avg.has(id)) continue;
      avg.set(id, {
        on_hand: 0,
        avg_cost: product.avg_cost,
        last_cost: product.last_cost,
        cost_changed_at: 0,
        pushed: false,
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
      // Plan against an overlay so a rejected transaction cannot advance the running
      // weighted-average state used by later transactions.
      const groupAvg = new CostOverlay(avg);
      try {
        const planned = ops.map((op) => planOp(ctx, look, ops, op, groupAvg));
        // A stored parent must not receive new children from a duplicate row. If every
        // insert in the transaction already exists this is a true replay (no side effects);
        // a mixture is a forged/invalid document and is rejected as a whole.
        const existing = planned.filter((p) => p.existingInsert).length;
        if (existing > 0 && existing < planned.length)
          throw new Reject('CONSTRAINT_FAILED');
        groups.push({ txId: ops[0]?.tx_id ?? '', planned });
        applyProductChanges(look, ops);
        applyBundleChanges(look, ops);
        applyStaffChanges(look, ops);
        applyShopChanges(look, ops);
        applyLedgerChanges(look, ops);
        applyCloseChanges(look, ops);
        groupAvg.commit();
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
          // A lost guard rolls back the whole transaction (`guardAssert`): replay every
          // op of the group, not only the guarded ones, so companions reach round 2 with
          // the purchase movement / recipe still in the group (API-H1, D-104).
          if (lostGroup) lost.push(g.planned.map((p) => p.op));
        }
        for (const r of res) {
          rowsWritten += r.meta.rows_written ?? 0;
          rowsRead += r.meta.rows_read ?? 0;
        }
      } catch (error) {
        if (isGuardAssertion(error)) {
          // D1 rolled the whole batch back. Retry every transaction in it intact; round 2
          // reloads the lookups so a concurrent writer's committed rev is used.
          for (const g of list) lost.push(g.planned.map((p) => p.op));
          return;
        }
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
  // API-H5: only a sale insert that actually applied may advance the device's
  // `last_invoice_seq`. Computing this during planning let a rejected, merged-away or
  // deferred sale (even with `Number.MAX_SAFE_INTEGER`) poison every later bill.
  let maxInvoiceSeq = 0;
  for (const op of ops) {
    if (op.tbl !== 'sales' || op.kind !== 'insert' || !op.row) continue;
    if (final.get(op.op_id)?.result !== 'applied') continue;
    const seq = Number(op.row.invoice_seq);
    if (Number.isSafeInteger(seq) && seq > 0)
      maxInvoiceSeq = Math.max(maxInvoiceSeq, seq);
  }
  if (maxInvoiceSeq > 0)
    tail.push(
      db.prepare(
        'UPDATE devices SET last_invoice_seq = MAX(last_invoice_seq, ?2) WHERE tenant_id = ?1 AND id = ?3',
        maxInvoiceSeq,
        ctx.device.id,
      ),
    );
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

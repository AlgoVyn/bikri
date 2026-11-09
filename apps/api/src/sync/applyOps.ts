/**
 * Push algorithm (03 §4.1). Every statement is tenant-scoped through `tenantDb`. Ops are grouped
 * by `tx_id` (one user action); a group is applied or rejected as a whole (D-104).
 * Write-rule checks live in `applyOpsCheck.ts`; shared types and helpers in `applyOpsShared.ts`.
 */
import {
  isLedgerTable,
  isMasterTable,
  movementChangesAvgCost,
  mulDivRound,
  newId,
  nextAvgCost,
  type Role,
} from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import { checkOp } from './applyOpsCheck.ts';
import {
  type ApplyContext,
  type ApplyOutcome,
  appliedOp,
  asPayment,
  type CloseCashMove,
  type CloseExpense,
  type ClosePayment,
  type CostState,
  changeLog,
  errorCodeOf,
  type Group,
  isD1ConstraintError,
  key,
  type Lookups,
  linkedInGroup,
  opRowKey,
  type Planned,
  Reject,
  type SaleInfo,
  type ShopRules,
  type StaffRow,
  StopExecution,
  sqlValue,
  writableColumns,
} from './applyOpsShared.ts';
import type { OpResult, PushOp } from './opSchema.ts';
import { applyRank, rowJsonExpr } from './tables.ts';

export type { ApplyContext, ApplyOutcome } from './applyOpsShared.ts';
export {
  CallBudget,
  errorCodeOf,
  MAX_D1_CALLS,
  MAX_ROW_OP_SKEW_MS,
  writableColumns,
} from './applyOpsShared.ts';

/** Builds the statements of one op (03 §4.1 step 4). Throws Reject for checks it can do. */
function planOp(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  avg: Map<string, CostState>,
): Planned {
  const { db, now } = ctx;
  const deviceId = ctx.device.id;
  checkOp(ctx, look, group, op, avg);
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
  avg: Map<string, CostState>,
): D1PreparedStatement[] {
  const { db, now } = ctx;
  const out: D1PreparedStatement[] = [];
  const saleStatus = (saleId: string) => [
    db.prepare(
      `UPDATE sales SET status = CASE
         WHEN EXISTS (SELECT 1 FROM sale_voids v WHERE v.tenant_id = ?1 AND v.sale_id = ?2) THEN 'void'
         WHEN NOT EXISTS (
           SELECT 1 FROM sale_lines sl
           WHERE sl.tenant_id = ?1 AND sl.sale_id = ?2
             AND sl.qty_milli > COALESCE((
               SELECT SUM(rl.qty_milli) FROM refund_lines rl
               JOIN refunds r ON r.tenant_id = rl.tenant_id AND r.id = rl.refund_id
               WHERE rl.tenant_id = ?1 AND r.tenant_id = ?1
                 AND rl.sale_line_id = sl.id
             ), 0)
         ) THEN 'refunded'
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
        state.last_cost = Number(row.unit_cost);
        state.cost_changed_at = Number(row.created_at ?? now);
        state.pushed = true;
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
  avg: Map<string, CostState>,
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
      if (Number(line.restock ?? 1) !== 1) continue;
      const saleLineId = String(line.sale_line_id);
      const pushed = group.find(
        (candidate) =>
          candidate.tbl === 'sale_lines' &&
          candidate.kind === 'insert' &&
          candidate.row?.id === saleLineId,
      )?.row;
      const productId =
        pushed?.product_id ?? look.saleLineById.get(saleLineId)?.product_id;
      if (typeof productId !== 'string') continue;
      byProduct.set(
        productId,
        (byProduct.get(productId) ?? 0) + number(line.qty_milli),
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
      // An over-refund is accepted as a conflict, but it must never restock more
      // units than the sale actually removed.
      const missing = Math.min(qty - moved, sold - moved);
      if (missing > 0)
        addMovement(productId, missing, 'refund_return', 'refund', id, null);
    }
  }

  if (tbl === 'sale_voids') {
    const saleId = String(row.sale_id);
    const seen = new Set<string>();
    const lines: { id: string; product_id: string | null }[] = [
      ...(look.saleLinesBySale.get(saleId) ?? []),
      ...(linkedInGroup(group, 'sale_lines', 'sale_id', saleId) as {
        id: string;
        product_id: string | null;
      }[]),
    ].filter((line) => {
      const id = String(line.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    for (const line of lines) {
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
    if (op.tbl === 'sales' && typeof op.row?.customer_id === 'string')
      partyIds.customer.add(op.row.customer_id);
    if (op.tbl === 'purchases' && typeof op.row?.supplier_id === 'string')
      partyIds.supplier.add(op.row.supplier_id);
    if (
      op.tbl === 'supplier_returns' &&
      typeof op.row?.supplier_id === 'string'
    )
      partyIds.supplier.add(op.row.supplier_id);
    if (op.tbl === 'refunds' && typeof op.row?.id === 'string')
      refundIds.add(op.row.id);
    if (op.tbl === 'refund_lines' && typeof op.row?.sale_line_id === 'string')
      refundLineIds.add(op.row.sale_line_id);
    if (op.tbl === 'sale_lines' && typeof op.row?.product_id === 'string') {
      saleProductIds.add(op.row.product_id);
      products.add(op.row.product_id);
    }
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
        `SELECT p.id AS id, p.avg_cost AS avg_cost, p.last_cost AS last_cost,
          COALESCE((SELECT SUM(m.qty_delta_milli) FROM stock_movements m WHERE m.tenant_id = ?1 AND m.product_id = p.id), 0) AS on_hand,
          COALESCE((SELECT MAX(m.created_at) FROM stock_movements m WHERE m.tenant_id = ?1 AND m.product_id = p.id AND m.qty_delta_milli > 0 AND m.unit_cost IS NOT NULL), 0) AS cost_changed_at
         FROM products p WHERE p.tenant_id = ?1 AND p.id IN (${params})`,
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
      `SELECT id, amount, method, reverses_id, business_date FROM expenses WHERE tenant_id = ?1 AND id IN (${p})`,
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
    (p) =>
      `SELECT id, deleted_at FROM customers WHERE tenant_id = ?1 AND id IN (${p})`,
    { customers: true },
  );
  chunked(
    partyIds.supplier,
    (p) =>
      `SELECT id, deleted_at FROM suppliers WHERE tenant_id = ?1 AND id IN (${p})`,
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
      `SELECT id, price, avg_cost, last_cost, track_stock, updated_at FROM products WHERE tenant_id = ?1 AND id IN (${p})`,
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
    'SELECT tax_rate_bp, tax_mode, round_total_to, default_credit_limit, timezone, updated_at FROM shop WHERE tenant_id = ?1',
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
    partyDeleted: new Map(),
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
  // A refund or void can be pushed in the same request as the sale it refers to, but in a
  // later transaction (one user action = one tx). The sale lines are not in D1 yet, so
  // make every pending sale line visible to the document checks. A rejected sale still
  // fails its own FK when the child insert reaches D1.
  for (const op of ops) {
    if (op.tbl !== 'sale_lines' || op.kind !== 'insert' || !op.row) continue;
    const saleId = typeof op.row.sale_id === 'string' ? op.row.sale_id : '';
    const id = typeof op.row.id === 'string' ? op.row.id : '';
    if (!saleId || !id) continue;
    const line = {
      id,
      sale_id: saleId,
      product_id:
        typeof op.row.product_id === 'string' ? op.row.product_id : null,
      qty_milli: Number(op.row.qty_milli ?? 0),
    };
    if (!look.saleLineById.has(id)) {
      look.saleLineById.set(id, line);
      look.saleLineSale.set(id, saleId);
      const list = look.saleLinesBySale.get(saleId) ?? [];
      list.push(line);
      look.saleLinesBySale.set(saleId, list);
    }
  }
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
          business_date: String(r.business_date ?? ''),
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
        look.partyDeleted.set(
          key('customer', String(r.id)),
          r.deleted_at === null || r.deleted_at === undefined
            ? null
            : Number(r.deleted_at),
        );
      } else if ('suppliers' in k) {
        look.suppliers.add(String(r.id));
        look.partyDeleted.set(
          key('supplier', String(r.id)),
          r.deleted_at === null || r.deleted_at === undefined
            ? null
            : Number(r.deleted_at),
        );
      } else if ('partyBalance' in k) {
        look.partyBalances.set(
          key(k.partyBalance, String(r.id)),
          Number(r.n ?? 0),
        );
      } else if ('saleProducts' in k) {
        look.products.set(String(r.id), {
          price: Number(r.price ?? 0),
          avg_cost: Number(r.avg_cost ?? 0),
          last_cost: Number(r.last_cost ?? 0),
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
          last_cost: Number(r.last_cost ?? 0),
          cost_changed_at: Number(r.cost_changed_at ?? 0),
          pushed: false,
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
    if (op.tbl === 'customers') {
      look.customers.add(op.row.id);
      const partyKey = key('customer', op.row.id);
      if (!look.partyDeleted.has(partyKey))
        look.partyDeleted.set(
          partyKey,
          op.row.deleted_at === null || op.row.deleted_at === undefined
            ? null
            : Number(op.row.deleted_at),
        );
    }
    if (op.tbl === 'suppliers') {
      look.suppliers.add(op.row.id);
      const partyKey = key('supplier', op.row.id);
      if (!look.partyDeleted.has(partyKey))
        look.partyDeleted.set(
          partyKey,
          op.row.deleted_at === null || op.row.deleted_at === undefined
            ? null
            : Number(op.row.deleted_at),
        );
    }
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

/** Apply the product rows of a successfully planned transaction to the next group in order. */
function applyProductChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (
      op.tbl !== 'products' ||
      op.kind === 'delete' ||
      typeof op.row?.id !== 'string'
    )
      continue;
    const previous = look.products.get(op.row.id);
    look.products.set(op.row.id, {
      price: Number(op.row.price ?? previous?.price ?? 0),
      avg_cost: previous?.avg_cost ?? 0,
      last_cost: Number(op.row.last_cost ?? previous?.last_cost ?? 0),
      // Keep the persisted tracking mode for an existing row: a tracking change in a
      // later transaction must not make an earlier sale look tracked.
      track_stock: previous?.track_stock ?? Number(op.row.track_stock ?? 0),
      updated_at: Number(
        op.row.updated_at ?? previous?.updated_at ?? op.row.created_at ?? 0,
      ),
    });
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
    const merge = current.rev !== (op.base_rev ?? 0);
    const pick = (field: keyof StaffRow): unknown => {
      const raw = op.row?.[field];
      if (merge && !changed.has(field)) return current[field];
      return raw === undefined ? current[field] : raw;
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
    const merge = current !== null && (op.base_rev ?? 0) !== 0;
    const pick = (field: keyof ShopRules): unknown => {
      const raw = op.row?.[field];
      if (merge && !changed.has(field)) return current?.[field];
      return raw === undefined ? current?.[field] : raw;
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
  // Plan parents before the rows that reference them. A shop or staff change in an
  // earlier transaction must be visible to a sale in a later one.
  const groupRank = (group: PushOp[]): number =>
    Math.min(...group.map((op) => applyRank(op.tbl)));
  pending = [...pending].sort((a, b) => groupRank(a) - groupRank(b));
  for (let round = 0; round < 2 && pending.length > 0; round += 1) {
    if (ctx.budget.used >= ctx.budget.max - 2) break;
    const look = await loadLookups(ctx, pending.flat());
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
        // avg_cost is server-managed; never trust a client value.
        avg_cost: 0,
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
        applyProductChanges(look, ops);
        applyStaffChanges(look, ops);
        applyShopChanges(look, ops);
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

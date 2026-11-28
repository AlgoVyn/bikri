/**
 * Server-authored rows for documents (03 §4.1): stock movements, money/audit rows and
 * the stock repair path. Split from applyOps so the push algorithm stays readable; this
 * module is imported by `planOp` and has no dependency on applyOps itself.
 */
import {
  movementChangesAvgCost,
  newId,
  nextAvgCost,
  roundHalfAway,
} from '@bikri/core';
import type { D1Table } from '@bikri/db/tables';
import {
  insertIfNotAppliedSql,
  type Row,
  type TenantTable,
} from '../db/tenantDb.ts';
import {
  type ApplyContext,
  type CostMap,
  changeLog,
  type Lookups,
  linkedInGroup,
  notAppliedSql,
  Reject,
  rowInGroup,
  rowInGroupAny,
} from './applyOpsShared.ts';
import type { PushOp } from './opSchema.ts';
import { rowJsonExpr } from './tables.ts';

export type { ApplyContext, ApplyOutcome } from './applyOpsShared.ts';
export {
  CallBudget,
  errorCodeOf,
  MAX_D1_CALLS,
  MAX_ROW_OP_SKEW_MS,
  writableColumns,
} from './applyOpsShared.ts';

/** A prepared insert that is skipped when this transaction was already applied. */
function guardedInsert(
  ctx: ApplyContext,
  table: TenantTable,
  row: Record<string, unknown>,
  txId: string,
): D1PreparedStatement {
  const [sql, params] = insertIfNotAppliedSql(table, row as Row, txId);
  return ctx.db.prepare(sql, ...params);
}

/** Appends the transaction guard to an UPDATE; `params` are already bound. */
function guardedUpdate(
  ctx: ApplyContext,
  sql: string,
  params: (string | number | null)[],
  txId: string,
): D1PreparedStatement {
  return ctx.db.prepare(
    `${sql} AND ${notAppliedSql('?1', `?${params.length + 2}`)}`,
    ...params,
    txId,
  );
}

/** Derived values the server owns: sales.status, products.avg_cost, conflicts (03 §4.1, §5). */
export function sideEffects(
  ctx: ApplyContext,
  tbl: D1Table,
  row: Record<string, unknown>,
  avg: CostMap,
  group: PushOp[],
  txId: string,
): D1PreparedStatement[] {
  const { db, now } = ctx;
  const out: D1PreparedStatement[] = [];
  const saleStatus = (saleId: string) => [
    guardedUpdate(
      ctx,
      `UPDATE sales SET status = CASE
         WHEN EXISTS (SELECT 1 FROM sale_voids v WHERE v.tenant_id = ?1 AND v.sale_id = ?2) THEN 'void'
         WHEN NOT EXISTS (
           SELECT 1 FROM sale_lines sl
           WHERE sl.tenant_id = ?1 AND sl.sale_id = ?2
             AND sl.qty_milli > COALESCE((
               SELECT SUM(rl.qty_milli) FROM refund_lines rl
               WHERE rl.tenant_id = ?1 AND rl.sale_line_id = sl.id
             ), 0)
         ) THEN 'refunded'
         WHEN EXISTS (SELECT 1 FROM refunds r2 WHERE r2.tenant_id = ?1 AND r2.sale_id = ?2) THEN 'part_refunded'
         ELSE 'paid' END
       WHERE tenant_id = ?1 AND id = ?2`,
      [saleId],
      txId,
    ),
    changeLog(db, 'sales', saleId, 'upsert', null, now, true),
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
        `INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) SELECT ?1, ?2, '', 'refunds', ?3, 'refund_after_void', json_object('sale_id', ?4, 'row_ids', json_array(?3), 'excess_milli', 0), 'needs_owner', ?5 WHERE EXISTS (SELECT 1 FROM sale_voids WHERE tenant_id = ?1 AND sale_id = ?4) AND ${notAppliedSql('?1', '?6')}`,
        conflictId,
        String(row.id),
        String(row.sale_id),
        now,
        txId,
      ),
    );
    out.push(conflictLog(conflictId));
  }
  if (tbl === 'sale_voids') {
    // The reverse race (a refund already left the shop when this void arrives) is the
    // same money conflict; accept the real event and let the owner settle it.
    const conflictId = newId(now);
    out.push(
      db.prepare(
        `INSERT INTO sync_conflicts (tenant_id, id, op_id, tbl, row_id, kind, fields_json, resolution, at) SELECT ?1, ?2, '', 'sale_voids', ?3, 'refund_after_void', json_object('sale_id', ?4, 'row_ids', json_array(?3), 'excess_milli', 0), 'needs_owner', ?5 WHERE EXISTS (SELECT 1 FROM refunds WHERE tenant_id = ?1 AND sale_id = ?4) AND ${notAppliedSql('?1', '?6')}`,
        conflictId,
        String(row.id),
        String(row.sale_id),
        now,
        txId,
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
           AND ?5 > (s.paid_total - COALESCE((SELECT SUM(r2.amount) FROM refunds r2 WHERE r2.tenant_id = ?1 AND r2.sale_id = ?4 AND r2.id <> ?3), 0))
           AND ${notAppliedSql('?1', '?7')}`,
        conflictId,
        String(row.id),
        String(row.sale_id),
        Number(row.amount ?? 0),
        now,
        txId,
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
           AND (SELECT SUM(rl2.qty_milli) FROM refund_lines rl2 WHERE rl2.tenant_id = ?1 AND rl2.sale_line_id = ?4) > sl.qty_milli
           AND ${notAppliedSql('?1', '?6')}`,
        conflictId,
        String(row.id),
        String(row.sale_line_id),
        now,
        txId,
      ),
    );
    out.push(conflictLog(conflictId));
    // `sales.status` must be recomputed after every refund line is stored. The header's
    // status UPDATE would run before `refund_lines` (apply rank 12 < 13) and would see no
    // refunded quantity, so a full refund would stay `part_refunded`. Run it once, from
    // the last line of the refund, after that line is inserted.
    const refundId = String(row.refund_id);
    const saleId = rowInGroupAny(group, 'refunds', refundId)?.sale_id;
    const lastLine = linkedInGroup(
      group,
      'refund_lines',
      'refund_id',
      refundId,
    ).at(-1);
    if (typeof saleId === 'string' && String(lastLine?.id) === String(row.id))
      out.push(...saleStatus(saleId));
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
           AND (SELECT SUM(r2.qty_milli) FROM supplier_return_lines r2 WHERE r2.tenant_id = ?1 AND r2.purchase_line_id = ?4) > pl.qty_milli
           AND ${notAppliedSql('?1', '?6')}`,
        conflictId,
        String(row.id),
        row.purchase_line_id,
        now,
        txId,
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
        state.cost_changed_at = Math.max(
          state.cost_changed_at,
          Number(row.created_at ?? now),
        );
        state.pushed = true;
        // A costed delivery/stock-in usually carries a companion `products` upsert that
        // already bumped `rev` and logged `last_cost`. Bumping it again would make D1
        // `rev` disagree with `server_rev` and roll the client into a spurious field_merge
        // (API-M4). The final `avg_cost` is published below.
        const companion =
          rowInGroupAny(group, 'products', String(row.product_id)) !==
          undefined;
        out.push(
          guardedUpdate(
            ctx,
            companion
              ? 'UPDATE products SET avg_cost = ?2, last_cost = ?4 WHERE tenant_id = ?1 AND id = ?3 AND (avg_cost <> ?2 OR last_cost <> ?4)'
              : 'UPDATE products SET avg_cost = ?2, last_cost = ?4, rev = rev + 1 WHERE tenant_id = ?1 AND id = ?3 AND (avg_cost <> ?2 OR last_cost <> ?4)',
            [state.avg_cost, String(row.product_id), Number(row.unit_cost)],
            txId,
          ),
        );
        // Always publish the final server-owned cost. The rank-4 companion
        // `products` upsert (when present) logged `last_cost` before this update,
        // so it carries the stale pre-delivery `avg_cost`; a pull would otherwise
        // roll every till back to that average while D1 has already moved on.
        out.push(
          changeLog(db, 'products', row.product_id, 'upsert', null, now, true),
        );
      }
      // on_hand_milli and cost_changed_at are maintained by the
      // products_stock_after_movement trigger, so this path never bumps rev or writes a
      // change_log row for a sale.
      state.on_hand += qty;
    }
  }
  return out;
}

/**
 * Money-event audit integrity: verify the row the till sent with the event, or write the
 * canonical row here when it is missing. Refund/void/supplier-return/day-close amounts
 * are compared with the event, so a forged audit cannot disagree with the money row.
 */
export function moneyAuditStatements(
  ctx: ApplyContext,
  group: PushOp[],
  tbl: string,
  row: Record<string, unknown>,
  txId: string,
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
    guardedInsert(ctx, 'audit_log', auditRow, txId),
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
export function stockRepairStatements(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  tbl: string,
  row: Record<string, unknown>,
  avg: CostMap,
  txId: string,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const number = (value: unknown): number => Number(value ?? 0);
  const id = String(row.id);
  const deviceId = String(row.device_id);
  const branchId =
    typeof row.branch_id === 'string'
      ? row.branch_id
      : tbl === 'sale_voids'
        ? (look.sales.get(String(row.sale_id))?.branch_id ??
          look.pushedSales.get(String(row.sale_id))?.branch_id ??
          '')
        : '';
  const staffId = String(row.staff_id);
  const businessDate = String(row.business_date);
  const createdAt = number(row.created_at);
  const movements = (reason: string, refId: string, productId: string) =>
    linkedInGroup(group, 'stock_movements', 'ref_id', refId).filter(
      (movement) =>
        movement.reason_code === reason && movement.product_id === productId,
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
      guardedInsert(ctx, 'stock_movements', movement, txId),
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
      out.push(
        ...sideEffects(ctx, 'stock_movements', movement, avg, group, txId),
      );
    else {
      // A non-costed repair still moves stock. Later costed movements in the same push
      // are planned against this overlay, so it must include the repaired quantity
      // (API-L9); `sideEffects` already does this for the costed path.
      const state = avg.get(productId);
      if (state) state.on_hand += qty;
    }
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
        (sum, movement) => sum - number(movement.qty_delta_milli),
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
        (sum, movement) => sum + number(movement.qty_delta_milli),
        0,
      );
      const missing = info.qty - moved;
      if (missing <= 0) continue;
      // Accumulate in BigInt: the product of a large quantity and a large landed cost
      // can exceed Number.MAX_SAFE_INTEGER before the division (API-L1).
      let cost = 0n;
      for (const line of lines) {
        if (line.product_id !== productId) continue;
        cost +=
          BigInt(number(line.qty_milli)) *
          BigInt(number(line.landed_unit_cost));
      }
      let unitCost: number | null = null;
      if (info.qty > 0) {
        try {
          unitCost = roundHalfAway(cost, BigInt(info.qty));
        } catch {
          // An out-of-range repair would otherwise surface as an HTTP 500.
          continue;
        }
      }
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
        (sum, movement) => sum + -number(movement.qty_delta_milli),
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
      const pushed = rowInGroup(group, 'sale_lines', saleLineId);
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
          (sum, movement) => sum - number(movement.qty_delta_milli),
          0,
        );
      if (sold <= 0) continue;
      const moved = movements('refund_return', id, productId).reduce(
        (sum, movement) => sum + number(movement.qty_delta_milli),
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
    // One repair per product, not per line: a product can appear on several lines of
    // the same sale (for example standalone and inside a bundle), and `sold` is the
    // whole sale's movement for that product.
    const products = new Set<string>();
    for (const line of lines) {
      if (line.product_id) products.add(line.product_id);
    }
    for (const productId of products) {
      const sold =
        (look.saleMoved.get(saleId)?.get(productId) ?? 0) +
        movements('sale', saleId, productId).reduce(
          (sum, movement) => sum - number(movement.qty_delta_milli),
          0,
        );
      if (sold <= 0) continue;
      const moved = movements('void_return', id, productId).reduce(
        (sum, movement) => sum + number(movement.qty_delta_milli),
        0,
      );
      const missing = sold - moved;
      if (missing > 0)
        addMovement(productId, missing, 'void_return', 'void', id, null);
    }
  }
  return out;
}

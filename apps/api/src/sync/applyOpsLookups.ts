/**
 * Push lookups (03 §4.1): one pass over the ops of a push collects the stored rows the
 * checks and server-authored statements need, so planOp does not issue a query per op.
 * Split out of applyOpsServerRows so the row builders stay readable.
 */
import { isLedgerTable, isMasterTable } from '@bikri/core';
import {
  type ApplyContext,
  asPayment,
  key,
  type Lookups,
  type ShopRules,
  type StaffRow,
} from './applyOpsShared.ts';
import type { PushOp } from './opSchema.ts';

export async function loadLookups(
  ctx: ApplyContext,
  ops: PushOp[],
): Promise<Lookups> {
  const { db } = ctx;
  const byTable = new Map<string, Set<string>>();
  const ledgerByTable = new Map<string, Set<string>>();
  const products = new Set<string>();
  const saleProductIds = new Set<string>();
  const saleIds = new Set<string>();
  /** Sales whose void is being pushed; only their void payments are needed. */
  const voidSaleIds = new Set<string>();
  const refundIds = new Set<string>();
  const returnIds = new Set<string>();
  const purchaseIds = new Set<string>();
  const purchaseLineIds = new Set<string>();
  const refundLineIds = new Set<string>();
  const expenseIds = new Set<string>();
  const reversalIds = new Set<string>();
  /** Bundle recipes needed by sale lines, recipe edits and kind changes. */
  const bundleIds = new Set<string>();
  /** Recipe rows touched by a bundle_items op (a delete has no row payload). */
  const bundleItemIds = new Set<string>();
  /** Products being deleted or changing kind: is a bundle using them? */
  const componentCandidates = new Set<string>();
  const partyIds = {
    customer: new Set<string>(),
    supplier: new Set<string>(),
  };
  const deleteParties = {
    customer: new Set<string>(),
    supplier: new Set<string>(),
  };
  const closeDevices = new Set<string>();
  const quoteIds = new Set<string>();
  let closeStart = Number.POSITIVE_INFINITY;
  let closeEnd = Number.NEGATIVE_INFINITY;
  for (const op of ops) {
    if (
      (op.tbl === 'sale_voids' || op.tbl === 'refunds') &&
      typeof op.row?.sale_id === 'string'
    )
      saleIds.add(op.row.sale_id);
    // A reissued sale is checked against the snapshot of the sale it replaces (07 §6.2),
    // so its lines must be loaded as well.
    if (
      op.tbl === 'sales' &&
      op.kind !== 'delete' &&
      typeof op.row?.replaces_sale_id === 'string'
    )
      saleIds.add(op.row.replaces_sale_id);
    if (
      op.tbl === 'quotations' &&
      op.kind !== 'delete' &&
      typeof op.row?.converted_sale_id === 'string'
    )
      saleIds.add(op.row.converted_sale_id);
    if (op.tbl === 'sale_voids' && typeof op.row?.sale_id === 'string')
      voidSaleIds.add(op.row.sale_id);
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
    if (
      (op.tbl === 'sale_lines' || op.tbl === 'quotation_lines') &&
      typeof op.row?.product_id === 'string'
    ) {
      saleProductIds.add(op.row.product_id);
      products.add(op.row.product_id);
    }
    if (
      (op.tbl === 'sale_lines' || op.tbl === 'quotation_lines') &&
      typeof op.row?.bundle_id === 'string'
    )
      saleProductIds.add(op.row.bundle_id);
    if (op.tbl === 'sale_lines' && typeof op.row?.bundle_id === 'string')
      bundleIds.add(op.row.bundle_id);
    if (op.tbl === 'bundle_items') {
      if (typeof op.row?.bundle_id === 'string')
        bundleIds.add(op.row.bundle_id);
      const itemId = op.kind === 'delete' ? op.row_id : op.row?.id;
      if (typeof itemId === 'string') bundleItemIds.add(itemId);
    }
    if (op.tbl === 'products') {
      const id = op.kind === 'delete' ? op.row_id : op.row?.id;
      if (typeof id === 'string') {
        // Only a delete or a kind change needs "is a bundle using this product?".
        // A normal price/cost edit must stay allowed (D-231).
        if (
          op.kind === 'delete' ||
          op.row?.deleted_at != null ||
          (op.changed_fields ?? []).includes('kind')
        )
          componentCandidates.add(id);
        // The D-229 invariants are checked on the state every product op leaves, so its
        // recipe must be loaded even when the op writes neither `kind` nor `track_stock`
        // (API-H6). A deleted row keeps the old recipe for the delete checks.
        if (op.kind !== 'delete') bundleIds.add(id);
      }
    }
    if (op.tbl === 'products' && typeof op.row?.id === 'string')
      saleProductIds.add(op.row.id);
    if (op.tbl === 'bundle_items') {
      for (const field of ['bundle_id', 'component_product_id'] as const) {
        const id = op.row?.[field];
        if (typeof id === 'string') saleProductIds.add(id);
      }
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
      const start = Number(op.row.period_start);
      const end = Number(op.row.period_end);
      if (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start <= end
      ) {
        closeDevices.add(op.row.device_id);
        closeStart = Math.min(closeStart, start);
        closeEnd = Math.max(closeEnd, end);
      }
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
      (op.kind === 'delete' ||
        (op.kind === 'upsert' && op.row?.deleted_at != null)) &&
      (op.tbl === 'customers' || op.tbl === 'suppliers')
    ) {
      const partyId = op.kind === 'delete' ? op.row_id : op.row?.id;
      if (typeof partyId === 'string')
        deleteParties[op.tbl === 'customers' ? 'customer' : 'supplier'].add(
          partyId,
        );
    }
    if (op.tbl === 'quotations') {
      const id = op.kind === 'delete' ? op.row_id : op.row?.id;
      if (typeof id === 'string') quoteIds.add(id);
    }
    if (op.tbl === 'quotation_lines' && typeof op.row?.quote_id === 'string')
      quoteIds.add(op.row.quote_id);
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
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      'SELECT id, role, permissions_json, max_discount_bp, active, deleted_at, created_at, updated_at, rev FROM staff WHERE tenant_id = ?1',
    ),
    db.prepare('SELECT id, bill_prefix FROM branches WHERE tenant_id = ?1'),
    // Shop rules travel in the same batch: a separate `db.first` after it cost one D1
    // round trip (and one budget slot) on every push and retry round.
    db.prepare(
      'SELECT tax_rate_bp, tax_mode, cost_method, round_total_to, default_credit_limit, timezone, updated_at FROM shop WHERE tenant_id = ?1',
    ),
  ];
  const kinds: Array<
    | { tbl: string }
    | { productRows: true }
    | { quotes: true }
    | { quoteLines: true }
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
    | { lastClose: true }
    | { closePayments: true }
    | { closeCashMoves: true }
    | { closeExpenses: true }
    | { saleLines: true }
    | { saleMoved: true }
    | { bundleRows: true }
    | { bundleDeleted: true }
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
  // `products` (stock movements, purchase/return lines) and `saleProductIds` (sale lines,
  // product edits, bundle recipes) overlap on almost every document. One query over the
  // union replaces two `WHERE id IN (...)` scans of the same rows.
  const productList = [...new Set([...products, ...saleProductIds])];
  const productQuery = (params: string) =>
    `SELECT id, price, avg_cost, last_cost, track_stock, updated_at, kind,
      deleted_at, on_hand_milli AS on_hand, cost_changed_at
     FROM products WHERE tenant_id = ?1 AND id IN (${params})`;
  for (let i = 0; i < productList.length; i += 90) {
    const chunk = productList.slice(i, i + 90);
    const params = chunk.map((_, j) => `?${j + 2}`).join(', ');
    stmts.push(db.prepare(productQuery(params), ...chunk));
    kinds.push({ productRows: true });
  }
  // A narrowed bundle_items update carries only the changed columns, so its bundle and
  // component ids are known only from the stored row. Load those products too; the
  // recipe check cannot resolve them from the op payload alone.
  const bundleItemList = [...bundleItemIds];
  for (let i = 0; i < bundleItemList.length; i += 90) {
    const chunk = bundleItemList.slice(i, i + 90);
    const params = chunk.map((_, j) => `?${j + 2}`).join(', ');
    stmts.push(
      db.prepare(
        `SELECT id, price, avg_cost, last_cost, track_stock, updated_at, kind,
          deleted_at, on_hand_milli AS on_hand, cost_changed_at
         FROM products WHERE tenant_id = ?1 AND id IN (
           SELECT bundle_id FROM bundle_items WHERE tenant_id = ?1 AND id IN (${params})
           UNION
           SELECT component_product_id FROM bundle_items WHERE tenant_id = ?1 AND id IN (${params})
         )`,
        ...chunk,
      ),
    );
    kinds.push({ productRows: true });
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
    quoteIds,
    (p) =>
      `SELECT id, rev, deleted_at, quote_no, quote_seq, branch_id, device_id, staff_id,
        customer_id, business_date, valid_until, status, line_count, items_qty_milli,
        gross_total, item_discount_total, subtotal, bill_discount_type,
        bill_discount_value, bill_discount, tax_rate_bp, tax, tax_inclusive,
        round_total_to, rounding, total, converted_sale_id, converted_at,
        cancelled_reason, cancelled_at, updated_by
       FROM quotations WHERE tenant_id = ?1 AND id IN (${p})`,
    { quotes: true },
  );
  chunked(
    quoteIds,
    (p) =>
      `SELECT id, quote_id, line_no, product_id, name_snapshot, sku_snapshot,
        qty_milli, unit_price, gross, discount_type, discount_value, discount,
        net, note, unit_cost_snapshot, bundle_id, bundle_group, bundle_name,
        bundle_qty, bundle_price, bundle_component_qty_milli, bundle_discount,
        deleted_at, rev, updated_by
       FROM quotation_lines WHERE tenant_id = ?1 AND quote_id IN (${p})`,
    { quoteLines: true },
  );
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
    voidSaleIds,
    (p) =>
      `SELECT sale_id AS id, direction, purpose, method, amount FROM payments WHERE tenant_id = ?1 AND purpose = 'void' AND sale_id IN (${p})`,
    { payments: 'sale' },
  );
  chunked(
    saleIds,
    (p) =>
      `SELECT id, sale_id, product_id, qty_milli, bundle_group, bundle_component_qty_milli, bundle_qty, bundle_id, bundle_name, bundle_price, bundle_discount, name_snapshot, net, unit_price FROM sale_lines WHERE tenant_id = ?1 AND sale_id IN (${p})`,
    { saleLines: true },
  );
  // Only the recipes this push can affect: the bundles named by sale/recipe/product ops,
  // the bundles of touched recipe rows (a delete has no row payload) and the bundles that
  // use a product being deleted or re-kinded. A normal sale with no bundle costs zero
  // reads here (D-231). Soft-deleted rows are included so a fresh-sale check can tell the
  // stored recipe apart from the one the till sold (API-M2); the active maps filter them out.
  const bundleSql = (where: string) =>
    `SELECT id, bundle_id, component_product_id, qty_milli, sort_order, updated_at, deleted_at FROM bundle_items WHERE tenant_id = ?1 AND ${where}`;
  chunked(bundleIds, (p) => bundleSql(`bundle_id IN (${p})`), {
    bundleRows: true,
  });
  chunked(
    bundleItemIds,
    (p) =>
      bundleSql(
        `bundle_id IN (SELECT bundle_id FROM bundle_items WHERE tenant_id = ?1 AND id IN (${p}))`,
      ),
    { bundleRows: true },
  );
  chunked(
    componentCandidates,
    (p) => bundleSql(`component_product_id IN (${p})`),
    { bundleRows: true },
  );
  chunked(
    componentCandidates,
    (p) =>
      `SELECT p.id FROM products p JOIN bundle_items bi ON bi.tenant_id = p.tenant_id AND bi.bundle_id = p.id WHERE p.tenant_id = ?1 AND bi.tenant_id = ?1 AND bi.deleted_at IS NULL AND p.deleted_at IS NOT NULL AND bi.component_product_id IN (${p})`,
    { bundleDeleted: true },
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
    closeDevices,
    (p) =>
      `SELECT d.device_id AS id, d.id AS close_id, d.period_end, d.counted_cash
       FROM day_closes d
       WHERE d.tenant_id = ?1 AND d.device_id IN (${p})
         AND NOT EXISTS (
           SELECT 1 FROM day_closes d2
           WHERE d2.tenant_id = ?1 AND d2.device_id = d.device_id
             AND (d2.period_end > d.period_end
               OR (d2.period_end = d.period_end AND d2.id > d.id))
         )`,
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
  const shop = (res[2]?.results?.[0] ?? null) as ShopRules | null;
  const look: Lookups = {
    sales: new Map(),
    pushedSales: new Map(),
    refundUdhaar: new Map(),
    refundAmount: new Map(),
    pushedRefundUdhaar: new Map(),
    pushedRefundAmount: new Map(),
    existingVoids: new Set(),
    linkedPayments: new Map(),
    linkedLedger: new Map(),
    purchaseLineSupplier: new Map(),
    saleLineSale: new Map(),
    saleLinesBySale: new Map(),
    saleLineById: new Map(),
    bundleRecipes: new Map(),
    bundleRecipeHistory: new Map(),
    bundleItemById: new Map(),
    bundleItemRows: new Map(),
    bundleOfComponent: new Map(),
    bundleDeleted: new Set(),
    saleMoved: new Map(),
    customers: new Set(),
    suppliers: new Set(),
    forwardParties: new Set(),
    forwardPartyDeleted: new Map(),
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
    quotes: new Map(),
    quoteLinesByQuote: new Map(),
    lastClose: new Map(),
    pushedCloses: new Map(),
    closePayments: new Map(),
    closeCashMoves: new Map(),
    closeExpenses: new Map(),
    rowsRead: res.reduce(
      (sum, result) => sum + (result.meta.rows_read ?? 0),
      0,
    ),
  };
  for (const s of (res[0]?.results ?? []) as StaffRow[])
    look.staff.set(s.id, s);
  for (const b of (res[1]?.results ?? []) as {
    id: string;
    bill_prefix: string;
  }[])
    look.branches.set(b.id, { bill_prefix: b.bill_prefix });
  // A sale/purchase may reference a party created in a later transaction of this push;
  // the batch orders parents first, and the real FK rejects a parent whose create was
  // rejected. Payments/ledger rows have no such FK and deliberately do not use this set.
  for (const op of ops) {
    if (op.kind === 'delete' || typeof op.row?.id !== 'string') continue;
    if (op.tbl === 'customers') {
      const partyKey = key('customer', op.row.id);
      look.forwardParties.add(partyKey);
      look.forwardPartyDeleted.set(
        partyKey,
        op.row.deleted_at === null || op.row.deleted_at === undefined
          ? null
          : Number(op.row.deleted_at),
      );
    }
    if (op.tbl === 'suppliers') {
      const partyKey = key('supplier', op.row.id);
      look.forwardParties.add(partyKey);
      look.forwardPartyDeleted.set(
        partyKey,
        op.row.deleted_at === null || op.row.deleted_at === undefined
          ? null
          : Number(op.row.deleted_at),
      );
    }
  }
  kinds.forEach((k, i) => {
    const rows = (res[i + 3]?.results ?? []) as Array<Record<string, unknown>>;
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
      } else if ('quotes' in k) {
        look.quotes.set(String(r.id), {
          id: String(r.id),
          rev: Number(r.rev),
          deleted_at: (r.deleted_at as number | null) ?? null,
          quote_no: String(r.quote_no),
          quote_seq: Number(r.quote_seq),
          branch_id: String(r.branch_id),
          device_id: String(r.device_id),
          staff_id: String(r.staff_id),
          customer_id: typeof r.customer_id === 'string' ? r.customer_id : null,
          business_date: String(r.business_date),
          valid_until: String(r.valid_until),
          status: String(r.status),
          line_count: Number(r.line_count),
          items_qty_milli: Number(r.items_qty_milli),
          gross_total: Number(r.gross_total),
          item_discount_total: Number(r.item_discount_total),
          subtotal: Number(r.subtotal),
          bill_discount_type:
            typeof r.bill_discount_type === 'string'
              ? r.bill_discount_type
              : null,
          bill_discount_value: Number(r.bill_discount_value),
          bill_discount: Number(r.bill_discount),
          tax_rate_bp: Number(r.tax_rate_bp),
          tax: Number(r.tax),
          tax_inclusive: Number(r.tax_inclusive),
          round_total_to: Number(r.round_total_to ?? 1),
          rounding: Number(r.rounding),
          total: Number(r.total),
          converted_sale_id:
            typeof r.converted_sale_id === 'string'
              ? r.converted_sale_id
              : null,
          converted_at:
            typeof r.converted_at === 'number' ? r.converted_at : null,
          cancelled_reason: String(r.cancelled_reason ?? ''),
          cancelled_at:
            typeof r.cancelled_at === 'number' ? r.cancelled_at : null,
          updated_by: typeof r.updated_by === 'string' ? r.updated_by : null,
        });
      } else if ('quoteLines' in k) {
        const quoteId = String(r.quote_id);
        const list = look.quoteLinesByQuote.get(quoteId) ?? [];
        list.push({
          id: String(r.id),
          quote_id: quoteId,
          line_no: Number(r.line_no),
          product_id: typeof r.product_id === 'string' ? r.product_id : null,
          name_snapshot: String(r.name_snapshot),
          sku_snapshot: String(r.sku_snapshot ?? ''),
          qty_milli: Number(r.qty_milli),
          unit_price: Number(r.unit_price),
          gross: Number(r.gross),
          discount_type:
            typeof r.discount_type === 'string' ? r.discount_type : null,
          discount_value: Number(r.discount_value ?? 0),
          discount: Number(r.discount ?? 0),
          net: Number(r.net),
          note: String(r.note ?? ''),
          unit_cost_snapshot: Number(r.unit_cost_snapshot ?? 0),
          bundle_id: typeof r.bundle_id === 'string' ? r.bundle_id : null,
          bundle_group:
            typeof r.bundle_group === 'string' ? r.bundle_group : null,
          bundle_name: typeof r.bundle_name === 'string' ? r.bundle_name : null,
          bundle_qty:
            typeof r.bundle_qty === 'number' ? Number(r.bundle_qty) : null,
          bundle_price:
            typeof r.bundle_price === 'number' ? Number(r.bundle_price) : null,
          bundle_component_qty_milli:
            typeof r.bundle_component_qty_milli === 'number'
              ? Number(r.bundle_component_qty_milli)
              : null,
          bundle_discount: Number(r.bundle_discount ?? 0),
          deleted_at:
            typeof r.deleted_at === 'number' ? Number(r.deleted_at) : null,
          rev: Number(r.rev),
          updated_by: typeof r.updated_by === 'string' ? r.updated_by : null,
        });
        look.quoteLinesByQuote.set(quoteId, list);
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
          bundle_group:
            typeof r.bundle_group === 'string' ? r.bundle_group : null,
          bundle_component_qty_milli: Number(r.bundle_component_qty_milli ?? 0),
          bundle_qty: Number(r.bundle_qty ?? 0),
          bundle_id: typeof r.bundle_id === 'string' ? r.bundle_id : null,
          bundle_name: typeof r.bundle_name === 'string' ? r.bundle_name : null,
          bundle_price: Number(r.bundle_price ?? 0),
          bundle_discount: Number(r.bundle_discount ?? 0),
          name_snapshot:
            typeof r.name_snapshot === 'string' ? r.name_snapshot : null,
          net: Number(r.net ?? 0),
          unit_price: Number(r.unit_price ?? 0),
        };
        const list = look.saleLinesBySale.get(saleId) ?? [];
        list.push(line);
        look.saleLinesBySale.set(saleId, list);
        look.saleLineById.set(line.id, {
          sale_id: saleId,
          product_id: line.product_id,
          qty_milli: line.qty_milli,
          bundle_group: line.bundle_group,
          bundle_component_qty_milli: line.bundle_component_qty_milli,
          bundle_qty: line.bundle_qty,
          bundle_id: line.bundle_id,
          bundle_name: line.bundle_name,
          bundle_price: line.bundle_price,
          bundle_discount: line.bundle_discount,
          name_snapshot: line.name_snapshot,
          net: line.net,
          unit_price: line.unit_price,
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
      } else if ('productRows' in k) {
        look.products.set(String(r.id), {
          price: Number(r.price ?? 0),
          avg_cost: Number(r.avg_cost ?? 0),
          last_cost: Number(r.last_cost ?? 0),
          track_stock: Number(r.track_stock ?? 0),
          updated_at: Number(r.updated_at ?? 0),
          kind: String(r.kind ?? 'simple'),
          deleted_at: r.deleted_at === null ? null : Number(r.deleted_at ?? 0),
          pushed: false,
        });
        look.onHand.set(String(r.id), {
          on_hand: Number(r.on_hand),
          avg_cost: Number(r.avg_cost),
          last_cost: Number(r.last_cost ?? 0),
          cost_changed_at: Number(r.cost_changed_at ?? 0),
          pushed: false,
        });
      } else if ('bundleDeleted' in k) {
        look.bundleDeleted.add(String(r.id));
      } else if ('bundleRows' in k) {
        const bundleId = String(r.bundle_id);
        const deletedAt =
          r.deleted_at === null || r.deleted_at === undefined
            ? null
            : Number(r.deleted_at);
        const history = look.bundleRecipeHistory.get(bundleId) ?? [];
        history.push({
          updated_at: Number(r.updated_at ?? 0),
          deleted_at: deletedAt,
        });
        look.bundleRecipeHistory.set(bundleId, history);
        look.bundleItemRows.set(String(r.id), {
          id: String(r.id),
          bundle_id: bundleId,
          component_product_id: String(r.component_product_id),
          qty_milli: Number(r.qty_milli ?? 0),
          sort_order: Number(r.sort_order ?? 0),
          updated_at: Number(r.updated_at ?? 0),
          deleted_at: deletedAt,
        });
        // Active rows only: a deleted or soft-deleted recipe row no longer makes the
        // product a component nor counts toward the recipe.
        if (deletedAt !== null) continue;
        look.bundleRecipes.set(bundleId, [
          ...(look.bundleRecipes.get(bundleId) ?? []),
          {
            id: String(r.id),
            component_product_id: String(r.component_product_id),
            qty_milli: Number(r.qty_milli ?? 0),
            sort_order: Number(r.sort_order ?? 0),
            updated_at: Number(r.updated_at ?? 0),
            deleted_at: null,
          },
        ]);
        look.bundleItemById.set(String(r.id), {
          bundle_id: bundleId,
          component_product_id: String(r.component_product_id),
        });
        const componentId = String(r.component_product_id);
        const usedBy = look.bundleOfComponent.get(componentId) ?? [];
        if (!usedBy.includes(bundleId)) usedBy.push(bundleId);
        look.bundleOfComponent.set(componentId, usedBy);
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
      }
    }
  });
  return look;
}

/**
 * Applies the lookups of a successfully planned transaction to the next transaction in
 * the push. These were previously pre-loaded from every op, so a rejected transaction
 * could leak a customer/supplier/sale/refund into a later one (API-H2).
 */
export function applyLookupChanges(
  look: Lookups,
  ops: PushOp[],
  now: number,
): void {
  for (const op of ops) {
    if (op.tbl === 'customers' || op.tbl === 'suppliers') {
      const type = op.tbl === 'customers' ? 'customer' : 'supplier';
      const set = type === 'customer' ? look.customers : look.suppliers;
      const id = op.kind === 'delete' ? op.row_id : op.row?.id;
      if (typeof id !== 'string' || id === '') continue;
      set.add(id);
      const deleted =
        op.kind === 'delete'
          ? now
          : op.row?.deleted_at === null || op.row?.deleted_at === undefined
            ? null
            : Number(op.row.deleted_at);
      const previous = look.partyDeleted.get(key(type, id));
      // A soft-deleted party is never resurrected by an edit later in the push (API-M2).
      look.partyDeleted.set(
        key(type, id),
        previous === null || previous === undefined ? deleted : previous,
      );
      continue;
    }
    if (op.tbl === 'branches') {
      const id = op.kind === 'delete' ? op.row_id : op.row?.id;
      if (typeof id !== 'string' || id === '') continue;
      if (op.kind === 'delete') look.branches.delete(id);
      else if (!look.branches.has(id))
        look.branches.set(id, {
          bill_prefix: String(op.row?.bill_prefix ?? ''),
        });
      continue;
    }
    if (op.kind === 'delete' || typeof op.row?.id !== 'string') continue;
    const id = op.row.id;
    if (
      op.kind === 'upsert' &&
      (op.base_rev ?? 0) === 0 &&
      isMasterTable(op.tbl)
    )
      look.pushedCreates.add(key(op.tbl, id));
    if (op.tbl === 'sales') {
      look.pushedSales.set(id, {
        business_date: String(op.row.business_date ?? ''),
        branch_id: String(op.row.branch_id ?? ''),
        customer_id:
          typeof op.row.customer_id === 'string' ? op.row.customer_id : null,
        udhaar_amount: Number(op.row.udhaar_amount ?? 0),
        paid_total: Number(op.row.paid_total ?? 0),
      });
      continue;
    }
    if (op.tbl === 'sale_lines' && op.kind === 'insert') {
      const saleId = typeof op.row.sale_id === 'string' ? op.row.sale_id : '';
      if (saleId === '' || look.saleLineById.has(id)) continue;
      const line = {
        id,
        sale_id: saleId,
        product_id:
          typeof op.row.product_id === 'string' ? op.row.product_id : null,
        qty_milli: Number(op.row.qty_milli ?? 0),
        bundle_group:
          typeof op.row.bundle_group === 'string' ? op.row.bundle_group : null,
        bundle_component_qty_milli: Number(
          op.row.bundle_component_qty_milli ?? 0,
        ),
        bundle_qty: Number(op.row.bundle_qty ?? 0),
        bundle_id:
          typeof op.row.bundle_id === 'string' ? op.row.bundle_id : null,
        bundle_name:
          typeof op.row.bundle_name === 'string' ? op.row.bundle_name : null,
        bundle_price: Number(op.row.bundle_price ?? 0),
        bundle_discount: Number(op.row.bundle_discount ?? 0),
        name_snapshot:
          typeof op.row.name_snapshot === 'string'
            ? op.row.name_snapshot
            : null,
        net: Number(op.row.net ?? 0),
        unit_price: Number(op.row.unit_price ?? 0),
      };
      look.saleLineById.set(id, line);
      look.saleLineSale.set(id, saleId);
      const list = look.saleLinesBySale.get(saleId) ?? [];
      list.push(line);
      look.saleLinesBySale.set(saleId, list);
      continue;
    }
    if (
      op.tbl === 'refunds' &&
      op.kind === 'insert' &&
      typeof op.row.sale_id === 'string'
    ) {
      const saleId = op.row.sale_id;
      look.pushedRefundUdhaar.set(
        saleId,
        (look.pushedRefundUdhaar.get(saleId) ?? 0) +
          Number(op.row.udhaar_part ?? 0),
      );
      look.pushedRefundAmount.set(
        saleId,
        (look.pushedRefundAmount.get(saleId) ?? 0) + Number(op.row.amount ?? 0),
      );
    }
    if (op.tbl === 'sale_voids' && typeof op.row.sale_id === 'string')
      look.existingVoids.add(op.row.sale_id);
    if (op.tbl === 'expenses' && op.kind === 'insert') {
      // An offline expense and its reversal are separate transactions of one push; the
      // reversal check must see the original and its existing reversal (API-M1).
      const reverses =
        typeof op.row.reverses_id === 'string' ? op.row.reverses_id : null;
      look.expenses.set(id, {
        amount: Number(op.row.amount ?? 0),
        method: String(op.row.method ?? ''),
        reverses_id: reverses,
        business_date: String(op.row.business_date ?? ''),
      });
      if (reverses !== null) look.existingReversals.add(reverses);
    }
    if (
      op.tbl === 'purchase_lines' &&
      op.kind === 'insert' &&
      typeof op.row.purchase_id === 'string'
    ) {
      // A supplier return in a later transaction of this push links to the delivery line
      // pushed earlier; its supplier must still be verified (API-M1).
      const supplier = ops.find(
        (candidate) =>
          candidate.tbl === 'purchases' &&
          candidate.row?.id === op.row?.purchase_id,
      )?.row?.supplier_id;
      if (typeof supplier === 'string')
        look.purchaseLineSupplier.set(id, supplier);
    }
  }
}

/**
 * Add a successfully planned transaction's cash rows and closes to the day-close view of
 * the next transaction (API-L5). Pre-loading them from every op of the push let a later
 * close be validated against payments from an earlier transaction that was rejected.
 */
export function applyCloseChanges(look: Lookups, ops: PushOp[]): void {
  for (const op of ops) {
    if (op.kind !== 'insert' || !op.row) continue;
    const id = typeof op.row.id === 'string' ? op.row.id : '';
    const deviceId =
      typeof op.row.device_id === 'string' ? op.row.device_id : '';
    if (id === '' || deviceId === '') continue;
    const at = Number(op.row.created_at ?? 0);
    if (op.tbl === 'day_closes') {
      const list = look.pushedCloses.get(deviceId) ?? [];
      list.push({
        id,
        period_end: Number(op.row.period_end),
        counted_cash: Number(op.row.counted_cash),
      });
      look.pushedCloses.set(deviceId, list);
    } else if (op.tbl === 'payments') {
      look.closePayments.set(id, {
        id,
        device_id: deviceId,
        direction: String(op.row.direction),
        purpose: String(op.row.purpose),
        method: String(op.row.method),
        amount: Number(op.row.amount),
        created_at: at,
      });
    } else if (op.tbl === 'cash_moves') {
      look.closeCashMoves.set(id, {
        id,
        device_id: deviceId,
        kind: String(op.row.kind),
        amount: Number(op.row.amount),
        created_at: at,
      });
    } else if (op.tbl === 'expenses') {
      look.closeExpenses.set(id, {
        id,
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

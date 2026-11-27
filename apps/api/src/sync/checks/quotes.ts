/**
 * Quotation write rules (D-305, screens/21). A quote is a master document: editable
 * while open, converted/cancelled are terminal, and its totals are recomputed from the
 * non-deleted lines with the same `computeCart()` helpers as a sale. Quotes never write
 * stock, payments, ledger entries or day closes.
 */
import { type CartInput, can, computeCart, mulDivRound } from '@bikri/core';
import type {
  ApplyContext,
  Lookups,
  QuoteInfo,
  QuoteLineInfo,
  StaffRow,
} from '../applyOpsShared.ts';
import {
  DAY_MS,
  isBusinessDate,
  overrideFor,
  overrideForLine,
  Reject,
  staffForHistory,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';

const QUOTE_NO = /^QTN-([A-Z]{1,3})-(\d+)$/u;
const n = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Header fields that change the quote's prices/discounts and need Sell policy. */
const HEADER_POLICY_FIELDS = new Set([
  'bill_discount_type',
  'bill_discount_value',
  'bill_discount',
]);
/** Line fields that change a line's price, quantity or discount. */
const LINE_POLICY_FIELDS = new Set([
  'qty_milli',
  'unit_price',
  'discount_type',
  'discount_value',
  'discount',
  'gross',
  'net',
  'bundle_price',
  'bundle_discount',
  'bundle_qty',
  'bundle_component_qty_milli',
  'product_id',
  'bundle_id',
  'bundle_group',
]);
/** Line fields that can change which product a line points at. */
const LINE_PRODUCT_FIELDS = new Set([
  'product_id',
  'bundle_id',
  'bundle_group',
]);
/** Line fields that need a current-catalogue price check. */
const LINE_PRICE_FIELDS = new Set([
  'unit_price',
  'bundle_price',
  'bundle_discount',
  'product_id',
  'bundle_id',
  'bundle_group',
]);
const anyField = (
  changed: ReadonlySet<string>,
  fields: ReadonlySet<string>,
): boolean => [...fields].some((field) => changed.has(field));

function codeSet(ctx: ApplyContext): Set<string> {
  return new Set([
    ctx.device.device_code,
    ...String(ctx.device.device_code_history ?? '')
      .split(',')
      .filter(Boolean),
  ]);
}

function headerFrom(
  current: QuoteInfo | undefined,
  row: Record<string, unknown>,
  changedFields: readonly string[] | undefined,
): Record<string, unknown> {
  if (!current) return { ...row };
  const changed = new Set(changedFields ?? []);
  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(row)) {
    // `planOp` writes only `changed_fields` plus updated_at/updated_by for an existing
    // master row. Treating an empty list as "all fields" let a quote header claim a
    // status/total the next op then committed (API-H1).
    if (changed.has(key) || key === 'updated_at' || key === 'updated_by')
      out[key] = value;
  }
  return out;
}

function lineFrom(
  current: QuoteLineInfo | undefined,
  row: Record<string, unknown>,
  changedFields: readonly string[] | undefined,
): QuoteLineInfo {
  const changed = new Set(changedFields ?? []);
  const base: Record<string, unknown> = current
    ? { ...current }
    : {
        id: '',
        quote_id: '',
        line_no: 0,
        product_id: null,
        name_snapshot: '',
        sku_snapshot: '',
        qty_milli: 0,
        unit_price: 0,
        gross: 0,
        discount_type: null,
        discount_value: 0,
        discount: 0,
        net: 0,
        note: '',
        unit_cost_snapshot: 0,
        bundle_id: null,
        bundle_group: null,
        bundle_name: null,
        bundle_qty: null,
        bundle_price: null,
        bundle_component_qty_milli: null,
        bundle_discount: 0,
        deleted_at: null,
        rev: 0,
      };
  for (const [key, value] of Object.entries(row)) {
    if (
      !current ||
      changed.has(key) ||
      key === 'updated_at' ||
      key === 'updated_by'
    )
      base[key] = value;
  }
  // A stored soft-deleted line is never resurrected by an edit of the same push,
  // mirroring `planOp` (API-H1/API-H2).
  if (current?.deleted_at !== null && current?.deleted_at !== undefined)
    base.deleted_at = current.deleted_at;
  return base as unknown as QuoteLineInfo;
}

/** Effective lines of a quote after every line op in this transaction. */
export function effectiveQuoteLines(
  look: Lookups,
  group: PushOp[],
  quoteId: string,
): QuoteLineInfo[] {
  const map = new Map<string, QuoteLineInfo>();
  // Every stored line, including soft-deleted ones: an upsert naming a soft-deleted id
  // must merge with it, not look like a new insert (API-H1).
  for (const line of look.quoteLinesByQuote.get(quoteId) ?? [])
    map.set(line.id, line);
  for (const op of group) {
    if (op.tbl !== 'quotation_lines') continue;
    if (op.kind === 'delete') {
      const id = op.row_id;
      if (!id) continue;
      const stored = look.quoteLineById.get(id) ?? map.get(id);
      if (stored?.quote_id === quoteId) map.delete(id);
      continue;
    }
    const row = op.row ?? {};
    const id = str(row.id);
    if (!id) continue;
    const stored = look.quoteLineById.get(id) ?? map.get(id);
    // The stored parent wins: a client cannot re-parent a line by naming another quote.
    const target = stored?.quote_id ?? str(row.quote_id);
    if (target !== quoteId) continue;
    const merged = lineFrom(stored, row, op.changed_fields);
    if (merged.deleted_at === null || merged.deleted_at === undefined)
      map.set(id, merged);
    else map.delete(id);
  }
  return [...map.values()]
    .filter((line) => line.deleted_at === null || line.deleted_at === undefined)
    .sort((a, b) => a.line_no - b.line_no);
}

type QuoteMemo = {
  lines: QuoteLineInfo[];
  /** `undefined` = not computed yet, `null` = no such quote header. */
  header: Record<string, unknown> | null | undefined;
  /** computeCart output per header shape (bill discount/tax/rounding). */
  totals: Map<string, ReturnType<typeof computeCart>>;
  /** Line shape and unique line_no were validated once for these effective lines. */
  shapesChecked: boolean;
};

/**
 * A `checkQuoteHeader`/`checkQuoteLine`/`checkQuoteLineDelete` call used to rebuild the
 * effective line list and run `computeCart(60)` for every op: 61 runs for a 60-line quote
 * (H10). The group array is the transaction, so a WeakMap keeps one memo per quote and
 * releases it with the request.
 */
const quoteMemos = new WeakMap<PushOp[], Map<string, QuoteMemo>>();

function quoteMemoFor(
  look: Lookups,
  group: PushOp[],
  quoteId: string,
): QuoteMemo {
  let byQuote = quoteMemos.get(group);
  if (byQuote === undefined) {
    byQuote = new Map();
    quoteMemos.set(group, byQuote);
  }
  let memo = byQuote.get(quoteId);
  if (memo === undefined) {
    memo = {
      lines: effectiveQuoteLines(look, group, quoteId),
      header: undefined,
      totals: new Map(),
      shapesChecked: false,
    };
    byQuote.set(quoteId, memo);
  }
  return memo;
}

function assertLineShape(row: QuoteLineInfo): void {
  const qty = n(row.qty_milli);
  const price = n(row.unit_price);
  const gross = n(row.gross);
  const discount = n(row.discount);
  const net = n(row.net);
  const discountValue = n(row.discount_value);
  if (
    !Number.isSafeInteger(qty) ||
    qty <= 0 ||
    !Number.isSafeInteger(price) ||
    price < 0 ||
    !Number.isSafeInteger(gross) ||
    gross < 0 ||
    !Number.isSafeInteger(discount) ||
    discount < 0 ||
    !Number.isSafeInteger(net) ||
    net < 0 ||
    !Number.isSafeInteger(discountValue) ||
    discountValue < 0 ||
    net !== gross - discount ||
    row.line_no <= 0 ||
    row.name_snapshot.length === 0 ||
    row.name_snapshot.length > 120 ||
    row.sku_snapshot.length > 64 ||
    row.note.length > 60
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (
    row.discount_type !== null &&
    row.discount_type !== 'rs' &&
    row.discount_type !== 'pct'
  )
    throw new Reject('CONSTRAINT_FAILED');
  // A value without a type is silently ignored by computeCart; reject it so a later
  // edit cannot resurrect an unapproved amount (API-L2).
  if (row.discount_type === null && discountValue !== 0)
    throw new Reject('CONSTRAINT_FAILED');
}

function assertBundleShape(
  look: Lookups,
  lines: QuoteLineInfo[],
  productCheckLineIds?: ReadonlySet<string>,
): void {
  const checkLine = (line: QuoteLineInfo) =>
    productCheckLineIds === undefined || productCheckLineIds.has(line.id);
  const groups = new Map<string, QuoteLineInfo[]>();
  for (const line of lines) {
    if (line.bundle_group === null) {
      if (
        line.bundle_id !== null ||
        line.bundle_name !== null ||
        line.bundle_qty !== null ||
        line.bundle_price !== null ||
        line.bundle_component_qty_milli !== null ||
        n(line.bundle_discount) !== 0
      )
        throw new Reject('CONSTRAINT_FAILED');
      if (checkLine(line)) {
        const product =
          line.product_id === null
            ? undefined
            : look.products.get(String(line.product_id));
        if (product && String(product.kind ?? 'simple') === 'bundle')
          throw new Reject('CONSTRAINT_FAILED');
      }
      continue;
    }
    const group = line.bundle_group;
    groups.set(group, [...(groups.get(group) ?? []), line]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    if (
      first.bundle_id === null ||
      first.bundle_name === null ||
      first.bundle_name.length === 0 ||
      first.bundle_qty === null ||
      n(first.bundle_qty) <= 0 ||
      first.bundle_price === null ||
      n(first.bundle_price) < 0 ||
      n(first.bundle_discount) < 0 ||
      n(first.bundle_discount) > n(first.bundle_price)
    )
      throw new Reject('CONSTRAINT_FAILED');
    const checkProducts = group.some(checkLine);
    if (checkProducts) {
      const bundle = look.products.get(String(first.bundle_id));
      if (!bundle || String(bundle.kind ?? 'simple') !== 'bundle')
        throw new Reject('CONSTRAINT_FAILED');
    }
    const componentIds = new Set<string>();
    let net = 0;
    for (const line of group) {
      if (
        line.bundle_id !== first.bundle_id ||
        line.bundle_name !== first.bundle_name ||
        n(line.bundle_qty) !== n(first.bundle_qty) ||
        n(line.bundle_price) !== n(first.bundle_price) ||
        n(line.bundle_discount) !== n(first.bundle_discount) ||
        line.bundle_component_qty_milli === null ||
        n(line.bundle_component_qty_milli) <= 0 ||
        line.product_id === null ||
        String(line.product_id) === String(line.bundle_id) ||
        n(line.qty_milli) !==
          n(line.bundle_component_qty_milli) * n(first.bundle_qty)
      )
        throw new Reject('CONSTRAINT_FAILED');
      if (componentIds.has(String(line.product_id)))
        throw new Reject('CONSTRAINT_FAILED');
      componentIds.add(String(line.product_id));
      if (checkLine(line)) {
        const component = look.products.get(String(line.product_id));
        if (!component || String(component.kind ?? 'simple') === 'bundle')
          throw new Reject('CONSTRAINT_FAILED');
      }
      net += n(line.net);
    }
    if (
      net !==
      (n(first.bundle_price) - n(first.bundle_discount)) * n(first.bundle_qty)
    )
      throw new Reject('CONSTRAINT_FAILED');
  }
}

/** The header as it will be stored after this transaction. */
export function effectiveQuoteHeader(
  look: Lookups,
  group: PushOp[],
  quoteId: string,
): Record<string, unknown> | null {
  const memo = quoteMemoFor(look, group, quoteId);
  if (memo.header !== undefined) return memo.header;
  const current = look.quotes.get(quoteId);
  const op = group.find(
    (candidate) =>
      candidate.tbl === 'quotations' &&
      candidate.kind !== 'delete' &&
      candidate.row?.id === quoteId,
  );
  if (op?.row) {
    memo.header = headerFrom(current, op.row, op.changed_fields);
    return memo.header;
  }
  memo.header = current ? { ...current } : null;
  return memo.header;
}

function assertTotals(
  look: Lookups,
  group: PushOp[],
  quoteId: string,
  header: Record<string, unknown>,
  productCheckLineIds?: ReadonlySet<string>,
): ReturnType<typeof computeCart> {
  const memo = quoteMemoFor(look, group, quoteId);
  const lines = memo.lines;
  if (lines.length < 1 || lines.length > 60)
    throw new Reject('CONSTRAINT_FAILED');
  if (!memo.shapesChecked) {
    const lineNos = new Set<number>();
    for (const line of lines) {
      assertLineShape(line);
      if (lineNos.has(line.line_no)) throw new Reject('CONSTRAINT_FAILED');
      lineNos.add(line.line_no);
    }
    memo.shapesChecked = true;
  }
  assertBundleShape(look, lines, productCheckLineIds);
  const billType = header.bill_discount_type;
  const billValue = n(header.bill_discount_value);
  if (billType !== null && billType !== 'rs' && billType !== 'pct')
    throw new Reject('CONSTRAINT_FAILED');
  if (billType === null && billValue !== 0)
    throw new Reject('CONSTRAINT_FAILED');
  const taxRateBp = n(header.tax_rate_bp);
  const taxInclusive =
    n(header.tax_inclusive) === 1 ? 'inclusive' : 'exclusive';
  const roundTotalTo = Math.max(1, n(header.round_total_to) || 1);
  // The document shape decides the totals; a note/status edit with the same lines reuses
  // the cached computeCart result instead of re-running the BigInt money path (H10).
  const totalsKey = `${String(billType)}|${billValue}|${taxRateBp}|${taxInclusive}|${roundTotalTo}`;
  let totals = memo.totals.get(totalsKey);
  if (totals === undefined) {
    const input: CartInput = {
      lines: lines.map((line) => ({
        qty_milli: n(line.qty_milli),
        unit_price: n(line.unit_price),
        ...(line.discount_type && n(line.discount_value) > 0
          ? {
              discount_type: line.discount_type as 'rs' | 'pct',
              discount_value: n(line.discount_value),
            }
          : {}),
      })),
      bill_discount:
        billType && billValue > 0
          ? { type: billType as 'rs' | 'pct', value: billValue }
          : null,
      tax_rate_bp: taxRateBp,
      tax_mode: taxInclusive,
      round_total_to: roundTotalTo,
    };
    try {
      totals = computeCart(input);
    } catch {
      throw new Reject('CONSTRAINT_FAILED');
    }
    memo.totals.set(totalsKey, totals);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const expected = totals.lines[i];
    if (
      !line ||
      !expected ||
      n(line.gross) !== expected.gross ||
      n(line.discount) !== expected.discount ||
      n(line.net) !== expected.net
    )
      throw new Reject('CONSTRAINT_FAILED');
  }
  const qty = lines.reduce((sum, line) => sum + n(line.qty_milli), 0);
  if (
    n(header.line_count) !== lines.length ||
    n(header.items_qty_milli) !== qty ||
    n(header.gross_total) !== totals.gross_total ||
    n(header.item_discount_total) !== totals.item_discount_total ||
    n(header.subtotal) !== totals.subtotal ||
    n(header.bill_discount) !== totals.bill_discount ||
    n(header.tax) !== totals.tax ||
    n(header.rounding) !== totals.rounding ||
    n(header.total) !== totals.total
  )
    throw new Reject('CONSTRAINT_FAILED');
  return totals;
}

/**
 * Sell policy for a quotation (screens/21): the same discount and below-catalogue
 * permissions as a sale, with the existing quote `override` audit rows as the
 * approval. Quantities/costs stay separate: a quote is non-financial.
 */
function assertQuotePolicy(
  look: Lookups,
  group: PushOp[],
  header: Record<string, unknown>,
  lines: QuoteLineInfo[],
  totals: ReturnType<typeof computeCart>,
  editor: StaffRow | null,
  entryAt: number,
  deviceSeenAt: number,
  priceLineIds?: ReadonlySet<string>,
): void {
  const quoteId = str(header.id);
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');
  const allowed = (permission: Parameters<typeof can>[2]) =>
    can(editor.role, editor.permissions_json, permission);

  const bundleResidual = lines.reduce(
    (sum, line) => sum + (line.bundle_id ? n(line.discount) : 0),
    0,
  );
  const groups = new Set<string>();
  let bundleDiscountTotal = 0;
  for (const line of lines) {
    if (!line.bundle_id || !line.bundle_group) continue;
    if (groups.has(line.bundle_group)) continue;
    groups.add(line.bundle_group);
    bundleDiscountTotal += n(line.bundle_discount) * n(line.bundle_qty ?? 0);
  }
  const discount =
    n(totals.item_discount_total) +
    n(totals.bill_discount) -
    bundleResidual +
    bundleDiscountTotal;
  if (discount > 0) {
    if (!allowed('sale.discount')) throw new Reject('FORBIDDEN');
    const base = n(header.gross_total) - bundleResidual + bundleDiscountTotal;
    if (base < 0) throw new Reject('CONSTRAINT_FAILED');
    const share = base === 0 ? 10_000 : mulDivRound(discount, 10_000, base);
    const limitFresh =
      !editor ||
      (entryAt >= Number(editor.updated_at ?? 0) &&
        Number(editor.updated_at ?? 0) <= deviceSeenAt);
    if (
      limitFresh &&
      share > Number(editor.max_discount_bp ?? 0) &&
      !overrideFor(
        group,
        'quotations',
        quoteId,
        'sale.discount',
        look.staff,
        ['owner', 'manager'],
        { excludeStaffId: editor.id, minDiscountBp: share },
      )
    )
      throw new Reject('FORBIDDEN');
  }

  const canEditPrice = allowed('catalog.edit');
  const checkedGroups = new Set<string>();
  for (const line of lines) {
    const productId =
      typeof line.product_id === 'string' ? line.product_id : null;
    const product = productId ? look.products.get(productId) : undefined;
    if (line.bundle_id && line.bundle_group) {
      if (checkedGroups.has(line.bundle_group)) continue;
      checkedGroups.add(line.bundle_group);
      const groupLines = lines.filter(
        (candidate) => candidate.bundle_group === line.bundle_group,
      );
      if (
        priceLineIds !== undefined &&
        !groupLines.some((candidate) => priceLineIds.has(candidate.id))
      )
        continue;
      const bundle = look.products.get(line.bundle_id);
      if (!bundle) continue;
      const priceKnown =
        Number(bundle.updated_at ?? 0) <= deviceSeenAt &&
        entryAt >= Number(bundle.updated_at ?? 0);
      if (!priceKnown) continue;
      const net = n(line.bundle_price ?? 0) - n(line.bundle_discount ?? 0);
      if (net >= Number(bundle.price ?? 0)) continue;
      const approved = lines.some(
        (candidate) =>
          candidate.bundle_group === line.bundle_group &&
          overrideForLine(
            look,
            group,
            'quotations',
            quoteId,
            candidate.id,
            net,
          ),
      );
      if (!canEditPrice && !approved) throw new Reject('FORBIDDEN');
      continue;
    }
    if (!product || line.unit_price >= Number(product.price ?? 0)) continue;
    if (priceLineIds !== undefined && !priceLineIds.has(line.id)) continue;
    const priceKnown =
      Number(product.updated_at ?? 0) <= deviceSeenAt &&
      entryAt >= Number(product.updated_at ?? 0);
    if (!priceKnown) continue;
    if (
      !canEditPrice &&
      !overrideForLine(
        look,
        group,
        'quotations',
        quoteId,
        line.id,
        n(line.unit_price),
      )
    )
      throw new Reject('FORBIDDEN');
  }
}

/** Validate the quote header and its effective document. */
export function checkQuoteHeader(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  row: Record<string, unknown>,
): void {
  const id = str(row.id);
  if (!id) throw new Reject('CONSTRAINT_FAILED');
  const current = look.quotes.get(id);
  const header = headerFrom(current, row, op.changed_fields);
  // A quote can be edited/converted offline and synced after the cashier's shift ended;
  // the action time, not "active now", decides authorization (API-H3).
  const editor = staffForHistory(
    look,
    group,
    row.updated_by ?? header.updated_by,
    header.updated_at ?? op.created_at,
  );
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');

  // Quote rows are never hard- or soft-deleted; cancellation is a status.
  if (header.deleted_at !== null && header.deleted_at !== undefined)
    throw new Reject('CONSTRAINT_FAILED');

  const status = str(header.status);
  const timestampValid = (value: unknown): boolean =>
    Number.isSafeInteger(n(value)) &&
    n(value) > 0 &&
    n(value) <= ctx.now + DAY_MS;
  if (status !== 'open' && status !== 'converted' && status !== 'cancelled')
    throw new Reject('CONSTRAINT_FAILED');
  if (
    !isBusinessDate(header.business_date) ||
    !isBusinessDate(header.valid_until)
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (header.valid_until < header.business_date)
    throw new Reject('CONSTRAINT_FAILED');
  if (
    Date.parse(`${String(header.valid_until)}T00:00:00Z`) -
      Date.parse(`${String(header.business_date)}T00:00:00Z`) >
    365 * DAY_MS
  )
    throw new Reject('CONSTRAINT_FAILED');
  if (
    !Number.isSafeInteger(n(header.line_count)) ||
    n(header.line_count) < 1 ||
    !Number.isSafeInteger(n(header.items_qty_milli)) ||
    n(header.items_qty_milli) < 1 ||
    !Number.isSafeInteger(n(header.tax_rate_bp)) ||
    n(header.tax_rate_bp) < 0 ||
    n(header.tax_rate_bp) > 5_000 ||
    !Number.isSafeInteger(n(header.round_total_to)) ||
    ![1, 100, 500, 1000].includes(n(header.round_total_to))
  )
    throw new Reject('CONSTRAINT_FAILED');

  if (!current) {
    if (status !== 'open') throw new Reject('CONSTRAINT_FAILED');
    if (str(header.device_id) !== ctx.device.id) throw new Reject('FORBIDDEN');
    const quoteNo = str(header.quote_no);
    const match = QUOTE_NO.exec(quoteNo);
    if (
      !match ||
      !codeSet(ctx).has(match[1] ?? '') ||
      Number(match[2]) !== n(header.quote_seq) ||
      !Number.isSafeInteger(n(header.quote_seq)) ||
      n(header.quote_seq) <= 0 ||
      quoteNo.length > 64
    )
      throw new Reject('CONSTRAINT_FAILED');
    if (!look.branches.has(str(header.branch_id)))
      throw new Reject('CONSTRAINT_FAILED');
    if (!staffForHistory(look, group, header.staff_id, header.created_at))
      throw new Reject('FORBIDDEN');
  } else {
    // These identify the document; a later edit cannot rewrite them.
    const changedFields = op.changed_fields ?? [];
    for (const field of [
      'quote_no',
      'device_id',
      'business_date',
      'staff_id',
      'branch_id',
    ] as const) {
      if (
        changedFields.includes(field) &&
        str(header[field]) !== str(current[field])
      )
        throw new Reject('CONSTRAINT_FAILED');
    }
    if (
      changedFields.includes('quote_seq') &&
      n(header.quote_seq) !== n(current.quote_seq)
    )
      throw new Reject('CONSTRAINT_FAILED');
    if (current.status === 'converted') {
      const allowed = new Set([
        'status',
        'converted_sale_id',
        'converted_at',
        'cancelled_at',
        'cancelled_reason',
        'updated_at',
        'updated_by',
        'rev',
      ]);
      const changed = op.changed_fields ?? Object.keys(row);
      const newSale = str(header.converted_sale_id);
      if (
        status !== 'converted' ||
        newSale === '' ||
        changed.some((field) => !allowed.has(field))
      )
        throw new Reject('CONSTRAINT_FAILED');
      // A second offline conversion (different sale) is allowed by D-305; an
      // idempotent replay of the same conversion is a no-op, not a rejection (API-H3).
    } else if (current.status === 'cancelled') {
      const converting = status === 'converted';
      const allowed = new Set(
        converting
          ? [
              'status',
              'converted_sale_id',
              'converted_at',
              'cancelled_at',
              'cancelled_reason',
              'updated_at',
              'updated_by',
              'rev',
            ]
          : ['status', 'updated_at', 'updated_by', 'rev'],
      );
      const changed = op.changed_fields ?? [];
      if (changed.some((field) => !allowed.has(field)))
        throw new Reject('CONSTRAINT_FAILED');
      if (converting) {
        if (
          str(header.converted_sale_id) === '' ||
          !timestampValid(header.converted_at) ||
          header.cancelled_at !== null ||
          str(header.cancelled_reason) !== ''
        )
          throw new Reject('CONSTRAINT_FAILED');
      } else if (status !== 'cancelled') {
        throw new Reject('CONSTRAINT_FAILED');
      }
    } else if (status === 'cancelled') {
      if (
        str(header.cancelled_reason).length < 1 ||
        str(header.cancelled_reason).length > 120 ||
        !timestampValid(header.cancelled_at)
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else if (status === 'converted') {
      if (
        str(header.converted_sale_id) === '' ||
        !timestampValid(header.converted_at)
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else if (status !== 'open') {
      throw new Reject('CONSTRAINT_FAILED');
    }
  }

  if (status === 'converted') {
    const saleId = str(header.converted_sale_id);
    if (!timestampValid(header.converted_at))
      throw new Reject('CONSTRAINT_FAILED');
    const inGroup = group.some(
      (candidate) =>
        candidate.tbl === 'sales' &&
        candidate.kind === 'insert' &&
        candidate.row?.id === saleId,
    );
    if (!inGroup && !look.sales.has(saleId))
      throw new Reject('CONSTRAINT_FAILED');
    if (header.cancelled_at !== null || str(header.cancelled_reason) !== '')
      throw new Reject('CONSTRAINT_FAILED');
  } else if (
    header.converted_sale_id !== null &&
    header.converted_sale_id !== undefined
  ) {
    throw new Reject('CONSTRAINT_FAILED');
  }
  if (status === 'cancelled') {
    if (!timestampValid(header.cancelled_at))
      throw new Reject('CONSTRAINT_FAILED');
    if (
      header.converted_sale_id !== null &&
      header.converted_sale_id !== undefined
    )
      throw new Reject('CONSTRAINT_FAILED');
  } else if (
    header.cancelled_at !== null ||
    str(header.cancelled_reason) !== ''
  ) {
    throw new Reject('CONSTRAINT_FAILED');
  }

  const lines = quoteMemoFor(look, group, id).lines;
  const totals = assertTotals(
    look,
    group,
    id,
    header,
    current ? new Set<string>() : undefined,
  );
  const changedHeader = new Set(op.changed_fields ?? []);
  // Price/discount policy belongs to writes that actually change them. A note,
  // terms, cancellation or conversion must not re-approve an old quote's prices.
  if (
    !current ||
    (status === 'open' && anyField(changedHeader, HEADER_POLICY_FIELDS))
  ) {
    assertQuotePolicy(
      look,
      group,
      header,
      lines,
      totals,
      editor,
      n(header.updated_at ?? op.created_at),
      ctx.deviceSeenAt ?? 0,
      current ? new Set<string>() : undefined,
    );
  }
}

/** Validate one quotation line against its document and the open quote state. */
export function checkQuoteLine(
  ctx: ApplyContext,
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  row: Record<string, unknown>,
): void {
  const rowId = str(row.id);
  const stored = rowId ? look.quoteLineById.get(rowId) : undefined;
  const claimed = str(row.quote_id);
  // The stored parent is authoritative; a client cannot re-parent a line by naming
  // another quote (API-H2).
  if (stored && claimed !== '' && claimed !== stored.quote_id)
    throw new Reject('CONSTRAINT_FAILED');
  const quoteId = stored?.quote_id ?? claimed;
  if (!quoteId) throw new Reject('CONSTRAINT_FAILED');
  const header = effectiveQuoteHeader(look, group, quoteId);
  if (!header) throw new Reject('FOREIGN_KEY');
  if (str(header.status) !== 'open') throw new Reject('CONSTRAINT_FAILED');
  // The client must send the full document total update with a line change.
  if (
    !group.some(
      (candidate) =>
        candidate.tbl === 'quotations' &&
        candidate.kind !== 'delete' &&
        candidate.row?.id === quoteId,
    )
  )
    throw new Reject('CONSTRAINT_FAILED');
  const editor = staffForHistory(
    look,
    group,
    row.updated_by ?? stored?.updated_by,
    header.updated_at ?? op.created_at,
  );
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');
  const lines = quoteMemoFor(look, group, quoteId).lines;
  const changed = new Set(op.changed_fields ?? []);
  const productCheck =
    !stored || anyField(changed, LINE_PRODUCT_FIELDS)
      ? new Set([rowId])
      : new Set<string>();
  const totals = assertTotals(look, group, quoteId, header, productCheck);
  if (!stored || anyField(changed, LINE_POLICY_FIELDS)) {
    const priceLineIds =
      !stored || anyField(changed, LINE_PRICE_FIELDS)
        ? new Set([rowId])
        : new Set<string>();
    assertQuotePolicy(
      look,
      group,
      header,
      lines,
      totals,
      editor,
      n(header.updated_at ?? op.created_at),
      ctx.deviceSeenAt ?? 0,
      priceLineIds,
    );
  }
}

/** A quotation line delete is allowed only while the quote is open and the header is updated. */
export function checkQuoteLineDelete(
  look: Lookups,
  group: PushOp[],
  op: PushOp,
): void {
  const id = op.row_id;
  if (!id) throw new Reject('CONSTRAINT_FAILED');
  const stored = id ? look.quoteLineById.get(id) : undefined;
  if (!stored) throw new Reject('CONSTRAINT_FAILED');
  const quoteId = stored.quote_id;
  const header = effectiveQuoteHeader(look, group, quoteId);
  if (!header || str(header.status) !== 'open')
    throw new Reject('CONSTRAINT_FAILED');
  if (
    !group.some(
      (candidate) =>
        candidate.tbl === 'quotations' &&
        candidate.kind !== 'delete' &&
        candidate.row?.id === quoteId,
    )
  )
    throw new Reject('CONSTRAINT_FAILED');
  const editor = staffForHistory(
    look,
    group,
    op.updated_by ?? stored.updated_by,
    header.updated_at ?? op.created_at,
  );
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');
  // Removing a line does not create a new price or discount; no policy re-approval.
  assertTotals(look, group, quoteId, header, new Set<string>());
}

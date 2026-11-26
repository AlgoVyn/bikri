/**
 * Quotation write rules (D-305, screens/21). A quote is a master document: editable
 * while open, converted/cancelled are terminal, and its totals are recomputed from the
 * non-deleted lines with the same `computeCart()` helpers as a sale. Quotes never write
 * stock, payments, ledger entries or day closes.
 */
import { type CartInput, can, computeCart } from '@bikri/core';
import type {
  ApplyContext,
  Lookups,
  QuoteInfo,
  QuoteLineInfo,
} from '../applyOpsShared.ts';
import {
  DAY_MS,
  isBusinessDate,
  Reject,
  staffForHistory,
  staffOf,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';

const QUOTE_NO = /^QTN-([A-Z]{1,3})-(\d+)$/u;
const n = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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
    if (changed.size === 0 || changed.has(key)) out[key] = value;
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
    if (changed.size === 0 || changed.has(key)) base[key] = value;
  }
  return base as unknown as QuoteLineInfo;
}

/** Effective lines of a quote after every line op in this transaction. */
export function effectiveQuoteLines(
  look: Lookups,
  group: PushOp[],
  quoteId: string,
): QuoteLineInfo[] {
  const map = new Map<string, QuoteLineInfo>();
  for (const line of look.quoteLinesByQuote.get(quoteId) ?? []) {
    if (line.deleted_at === null || line.deleted_at === undefined)
      map.set(line.id, line);
  }
  for (const op of group) {
    if (op.tbl !== 'quotation_lines') continue;
    if (op.kind === 'delete') {
      const id = op.row_id;
      if (!id) continue;
      const stored = map.get(id);
      if (stored?.quote_id === quoteId) map.delete(id);
      continue;
    }
    const row = op.row ?? {};
    if (str(row.quote_id) !== quoteId) continue;
    const id = str(row.id);
    if (!id) continue;
    const merged = lineFrom(map.get(id), row, op.changed_fields);
    if (merged.deleted_at === null) map.set(id, merged);
    else map.delete(id);
  }
  return [...map.values()].sort((a, b) => a.line_no - b.line_no);
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
}

function assertBundleShape(lines: QuoteLineInfo[]): void {
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
        n(line.qty_milli) !==
          n(line.bundle_component_qty_milli) * n(first.bundle_qty)
      )
        throw new Reject('CONSTRAINT_FAILED');
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
  const current = look.quotes.get(quoteId);
  const op = group.find(
    (candidate) =>
      candidate.tbl === 'quotations' &&
      candidate.kind !== 'delete' &&
      candidate.row?.id === quoteId,
  );
  if (op?.row) return headerFrom(current, op.row, op.changed_fields);
  if (!current) return null;
  return { ...current };
}

function assertTotals(
  header: Record<string, unknown>,
  lines: QuoteLineInfo[],
): void {
  if (lines.length < 1 || lines.length > 60)
    throw new Reject('CONSTRAINT_FAILED');
  const lineNos = new Set<number>();
  for (const line of lines) {
    assertLineShape(line);
    if (lineNos.has(line.line_no)) throw new Reject('CONSTRAINT_FAILED');
    lineNos.add(line.line_no);
  }
  assertBundleShape(lines);
  const billType = header.bill_discount_type;
  const billValue = n(header.bill_discount_value);
  if (billType !== null && billType !== 'rs' && billType !== 'pct')
    throw new Reject('CONSTRAINT_FAILED');
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
    tax_rate_bp: n(header.tax_rate_bp),
    tax_mode: n(header.tax_inclusive) === 1 ? 'inclusive' : 'exclusive',
    round_total_to: Math.max(1, n(header.round_total_to) || 1),
  };
  let totals: ReturnType<typeof computeCart>;
  try {
    totals = computeCart(input);
  } catch {
    throw new Reject('CONSTRAINT_FAILED');
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
  const editor = staffOf(look, group, op.updated_by ?? header.updated_by);
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');

  // Quote rows are never hard- or soft-deleted; cancellation is a status.
  if (header.deleted_at !== null && header.deleted_at !== undefined)
    throw new Reject('CONSTRAINT_FAILED');

  const status = str(header.status);
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
    n(header.round_total_to) <= 0
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
    for (const field of [
      'quote_no',
      'quote_seq',
      'device_id',
      'business_date',
      'staff_id',
    ] as const) {
      if (
        (op.changed_fields ?? []).includes(field) &&
        str(header[field]) !== str(current[field])
      )
        throw new Reject('CONSTRAINT_FAILED');
    }
    if (current.status === 'converted') {
      const allowed = new Set([
        'status',
        'converted_sale_id',
        'converted_at',
        'updated_at',
        'updated_by',
        'rev',
      ]);
      const changed = op.changed_fields ?? Object.keys(row);
      const newSale = str(header.converted_sale_id);
      if (
        status !== 'converted' ||
        newSale === '' ||
        newSale === str(current.converted_sale_id) ||
        changed.some((field) => !allowed.has(field))
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else if (current.status === 'cancelled') {
      const allowed = new Set(['updated_at', 'updated_by', 'rev']);
      const changed = op.changed_fields ?? Object.keys(row);
      if (changed.some((field) => !allowed.has(field)))
        throw new Reject('CONSTRAINT_FAILED');
    } else if (status === 'cancelled') {
      if (
        str(header.cancelled_reason).length < 1 ||
        str(header.cancelled_reason).length > 120 ||
        !Number.isSafeInteger(n(header.cancelled_at))
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else if (status === 'converted') {
      if (
        str(header.converted_sale_id) === '' ||
        !Number.isSafeInteger(n(header.converted_at))
      )
        throw new Reject('CONSTRAINT_FAILED');
    } else if (status !== 'open') {
      throw new Reject('CONSTRAINT_FAILED');
    }
  }

  if (status === 'converted') {
    const saleId = str(header.converted_sale_id);
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

  assertTotals(header, effectiveQuoteLines(look, group, id));
}

/** Validate one quotation line against its document and the open quote state. */
export function checkQuoteLine(
  look: Lookups,
  group: PushOp[],
  op: PushOp,
  row: Record<string, unknown>,
): void {
  const quoteId = str(row.quote_id);
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
  const editor = staffOf(look, group, op.updated_by ?? row.updated_by);
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');
  const lines = effectiveQuoteLines(look, group, quoteId);
  assertTotals(header, lines);
}

/** A quotation line delete is allowed only while the quote is open and the header is updated. */
export function checkQuoteLineDelete(
  look: Lookups,
  group: PushOp[],
  op: PushOp,
): void {
  const id = op.row_id;
  if (!id) throw new Reject('CONSTRAINT_FAILED');
  const stored = [...look.quoteLinesByQuote.values()]
    .flat()
    .find((line) => line.id === id);
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
  const editor = staffOf(look, group, op.updated_by ?? stored.updated_by);
  if (!editor || !can(editor.role, editor.permissions_json, 'sale.create'))
    throw new Reject('FORBIDDEN');
  assertTotals(header, effectiveQuoteLines(look, group, quoteId));
}

import { businessDate, newId } from '@bikri/core';
import type { PushOp } from '../../src/sync/opSchema.ts';
import { api, type BundleFixture, IDS, json, type Shop } from './fixtures.ts';

export type Dev = { id: string; token: string; code: string };

export function op(
  tbl: string,
  kind: 'insert' | 'upsert' | 'delete',
  row: Record<string, unknown>,
  extra: Partial<PushOp> = {},
): PushOp {
  const id = newId();
  return {
    op_id: id,
    tx_id: extra.tx_id ?? id,
    tbl,
    kind,
    ...(kind === 'delete' ? { row_id: String(row.id) } : { row }),
    ...(kind === 'upsert' ? { base_rev: 0, changed_fields: [] } : {}),
    ...(kind === 'delete' ? { base_rev: 0 } : {}),
    ...extra,
  } as PushOp;
}

export function productRow(
  id: string,
  fields: Record<string, unknown> = {},
  now = Date.now(),
) {
  return {
    id,
    name_en: 'Charger',
    name_ur: '',
    brand: '',
    category_id: null,
    sku: `SKU-${id.slice(-6)}`,
    unit: 'pc',
    price: 50000,
    last_cost: 0,
    min_stock_milli: 0,
    track_stock: 1,
    warranty_days: 0,
    notes: '',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    updated_by: IDS.owner,
    ...fields,
  };
}

export function saleOps(
  shop: Shop,
  dev: Dev,
  seq: number,
  opts: {
    customerId?: string | null;
    total?: number;
    prefix?: string;
    now?: number;
    saleId?: string;
    replacesSaleId?: string | null;
    staffId?: string;
  } = {},
): PushOp[] {
  const now = opts.now ?? Date.now();
  const total = opts.total ?? 150000;
  const saleId = opts.saleId ?? newId(now);
  const tx = newId(now);
  const sale = {
    id: saleId,
    invoice_no: `${opts.prefix ?? 'INV'}-${dev.code}-${seq}`,
    invoice_seq: seq,
    branch_id: shop.branchId,
    device_id: dev.id,
    staff_id: opts.staffId ?? IDS.cashier,
    customer_id: opts.customerId ?? null,
    business_date: businessDate(now),
    created_at: now,
    line_count: 1,
    items_qty_milli: 1000,
    gross_total: total,
    item_discount_total: 0,
    bundle_discount_total: 0,
    subtotal: total,
    bill_discount_type: null,
    bill_discount_value: 0,
    bill_discount: 0,
    tax_rate_bp: 0,
    tax: 0,
    tax_inclusive: 0,
    rounding: 0,
    total,
    paid_total: total,
    udhaar_amount: 0,
    cash_tendered: total,
    change_given: 0,
    replaces_sale_id: opts.replacesSaleId ?? null,
    note: '',
  };
  const line = {
    id: newId(now),
    sale_id: saleId,
    line_no: 1,
    product_id: IDS.product,
    name_snapshot: 'Phone',
    sku_snapshot: 'PHN-0001',
    qty_milli: 1000,
    unit_price: total,
    gross: total,
    discount_type: null,
    discount_value: 0,
    discount: 0,
    net: total,
    bill_discount_alloc: 0,
    tax_alloc: 0,
    rounding_alloc: 0,
    unit_cost_snapshot: 0,
    below_cost: 0,
    serial: '',
    warranty_until: null,
    created_at: now,
  };
  const payment = {
    id: newId(now),
    direction: 'in',
    method: 'cash',
    purpose: 'sale',
    amount: total,
    cash_tendered: total,
    change_given: 0,
    reference: '',
    sale_id: saleId,
    refund_id: null,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    branch_id: shop.branchId,
    device_id: dev.id,
    staff_id: IDS.cashier,
    business_date: businessDate(now),
    created_at: now,
  };
  return [
    op('sales', 'insert', sale, { tx_id: tx }),
    op('sale_lines', 'insert', line, { tx_id: tx }),
    op('payments', 'insert', payment, { tx_id: tx }),
  ];
}

/** A valid whole-bundle sale (four component lines) for the bundle policy tests. */
export function bundleSaleOps(
  shop: Shop,
  dev: Dev,
  seq: number,
  bundle: BundleFixture,
  opts: {
    now?: number;
    staffId?: string;
    bundlePrice?: number;
    bundleDiscount?: number;
    bundleQty?: number;
    prefix?: string;
    replacesSaleId?: string;
  } = {},
): PushOp[] {
  const now = opts.now ?? Date.now();
  const bundlePrice = opts.bundlePrice ?? 200000;
  const bundleDiscount = opts.bundleDiscount ?? 0;
  const bundleQty = opts.bundleQty ?? 1;
  const netTotal = (bundlePrice - bundleDiscount) * bundleQty;
  const lineNet = netTotal / (4 * bundleQty);
  if (!Number.isSafeInteger(lineNet) || lineNet < 0)
    throw new Error('bundleSaleOps needs an evenly divisible bundle total');
  const unitPrice = lineNet / bundleQty;
  if (!Number.isSafeInteger(unitPrice))
    throw new Error('bundleSaleOps needs an evenly divisible component price');
  const saleId = newId(now);
  const tx = newId(now);
  const group = newId(now);
  const sale = {
    id: saleId,
    invoice_no: `${opts.prefix ?? 'INV'}-${dev.code}-${seq}`,
    invoice_seq: seq,
    branch_id: shop.branchId,
    device_id: dev.id,
    staff_id: opts.staffId ?? IDS.cashier,
    customer_id: null,
    business_date: businessDate(now),
    created_at: now,
    line_count: 4,
    items_qty_milli: 4000 * bundleQty,
    gross_total: netTotal,
    item_discount_total: 0,
    bundle_discount_total: bundleDiscount * bundleQty,
    subtotal: netTotal,
    bill_discount_type: null,
    bill_discount_value: 0,
    bill_discount: 0,
    tax_rate_bp: 0,
    tax: 0,
    tax_inclusive: 0,
    rounding: 0,
    total: netTotal,
    paid_total: netTotal,
    udhaar_amount: 0,
    cash_tendered: netTotal,
    change_given: 0,
    replaces_sale_id: opts.replacesSaleId ?? null,
    note: '',
  };
  const lines = bundle.componentIds.map((productId, index) => ({
    id: newId(now),
    sale_id: saleId,
    line_no: index + 1,
    product_id: productId,
    business_date: sale.business_date,
    name_snapshot: `Component ${index + 1}`,
    sku_snapshot: `CMP-000${index + 1}`,
    qty_milli: 1000 * bundleQty,
    unit_price: unitPrice,
    gross: lineNet,
    discount_type: null,
    discount_value: 0,
    discount: 0,
    net: lineNet,
    bill_discount_alloc: 0,
    tax_alloc: 0,
    rounding_alloc: 0,
    unit_cost_snapshot: 0,
    below_cost: 0,
    serial: '',
    warranty_until: null,
    created_at: now,
    bundle_id: bundle.bundleId,
    bundle_group: group,
    bundle_name: 'Bundle',
    bundle_qty: bundleQty,
    bundle_price: bundlePrice,
    bundle_discount: bundleDiscount,
    bundle_component_qty_milli: 1000,
  }));
  const payment = {
    id: newId(now),
    direction: 'in',
    method: 'cash',
    purpose: 'sale',
    amount: netTotal,
    cash_tendered: netTotal,
    change_given: 0,
    reference: '',
    sale_id: saleId,
    refund_id: null,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    branch_id: shop.branchId,
    device_id: dev.id,
    staff_id: opts.staffId ?? IDS.cashier,
    business_date: sale.business_date,
    created_at: now,
  };
  return [
    op('sales', 'insert', sale, { tx_id: tx }),
    ...lines.map((line) => op('sale_lines', 'insert', line, { tx_id: tx })),
    ...(netTotal > 0 ? [op('payments', 'insert', payment, { tx_id: tx })] : []),
  ];
}

export type PushResponse = {
  results: Array<{
    op_id: string;
    result: string;
    error_code?: string;
    server_rev?: number;
  }>;
  latest_seq: number;
  tenant_status: { status: string; since: number | null };
  support: unknown;
};

export async function push(dev: Dev, ops: PushOp[], schemaVersion = 2) {
  return api('/sync/push', {
    method: 'POST',
    token: dev.token,
    json: {
      device_id: dev.id,
      schema_version: schemaVersion,
      app_version: '1.1.0',
      ops,
    },
  });
}

export async function pushOk(dev: Dev, ops: PushOp[]): Promise<PushResponse> {
  const res = await push(dev, ops);
  if (res.status !== 200)
    throw new Error(`push ${res.status}: ${await res.text()}`);
  return json<PushResponse>(res);
}

export type PullResponse = {
  changes: Array<{
    seq: number;
    tbl: string;
    op: string;
    row: Record<string, unknown>;
  }>;
  next_since: number;
  has_more: boolean;
  restore_epoch: string;
  tenant_status: { status: string };
  support: unknown;
};

export async function pullAll(
  dev: Dev,
  since = 0,
  limit = 1000,
): Promise<PullResponse['changes']> {
  const out: PullResponse['changes'] = [];
  let cursor = since;
  for (;;) {
    const res = await api(`/sync/pull?since=${cursor}&limit=${limit}`, {
      token: dev.token,
    });
    if (res.status !== 200)
      throw new Error(`pull ${res.status}: ${await res.text()}`);
    const body = await json<PullResponse>(res);
    out.push(...body.changes);
    cursor = body.next_since;
    if (!body.has_more) return out;
  }
}

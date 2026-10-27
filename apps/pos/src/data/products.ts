import { businessDate, generateSku, newId, type OpRow } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import type { Writer } from './write.ts';

export type NewProduct = {
  name_en: string;
  name_ur?: string;
  brand?: string;
  category_id?: string | null;
  sku?: string;
  barcodes?: string[];
  unit?: string;
  price: number;
  cost?: number;
  track_stock?: boolean;
  /** Opening stock in milli-units; with `cost` it becomes an `opening` movement (02 §5). */
  opening_milli?: number;
  warranty_days?: number;
  /** Low-stock alert (0 = off). */
  min_stock_milli?: number;
  notes?: string;
};

export type LedgerContext = {
  branch_id: string;
  device_id: string;
  staff_id: string;
  timeZone?: string;
};

/** Creates a product with its barcodes and opening stock in the caller's action. */
export async function createProduct(
  w: Writer,
  input: NewProduct,
  ctx: LedgerContext,
): Promise<MasterRow> {
  const name = input.name_en.trim();
  const row: OpRow = {
    name_en: name,
    name_ur: input.name_ur?.trim() ?? '',
    brand: input.brand?.trim() ?? '',
    category_id: input.category_id ?? null,
    sku: input.sku?.trim() || generateSku(name),
    unit: input.unit ?? 'pc',
    price: input.price,
    last_cost: input.cost ?? 0,
    avg_cost: input.cost ?? 0,
    min_stock_milli: input.min_stock_milli ?? 0,
    track_stock: input.track_stock === false ? 0 : 1,
    warranty_days: input.warranty_days ?? 0,
    image_key: null,
    notes: input.notes?.trim() ?? '',
  };
  const product = await w.create('products', row);
  for (const barcode of input.barcodes ?? []) {
    const code = barcode.trim();
    if (code)
      await w.create('product_barcodes', {
        product_id: product.id,
        barcode: code,
      });
  }
  const opening = input.opening_milli ?? 0;
  if (opening !== 0 && row.track_stock === 1) {
    await w.insert('stock_movements', {
      id: newId(w.now),
      product_id: product.id,
      qty_delta_milli: opening,
      reason_code: 'opening',
      ref_type: 'opening',
      ref_id: product.id,
      unit_cost: input.cost ?? 0,
      note: '',
      branch_id: ctx.branch_id,
      device_id: ctx.device_id,
      staff_id: ctx.staff_id,
      business_date: businessDate(w.now, ctx.timeZone),
      created_at: w.now,
    });
  }
  return product;
}

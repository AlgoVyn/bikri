import {
  generateSku,
  isQtyUnit,
  parseMoneyToPaisa,
  parseQtyToMilli,
} from '@bikri/core';
import type { BikriDb, MasterRow } from '@bikri/db';
import { productAudit } from './catalog.ts';
import { createProduct, type LedgerContext } from './products.ts';
import { type WriteOptions, writeAction } from './write.ts';

// Import spreadsheet (screens/08 § Import spreadsheet). Parsing of CSV / XLSX files happens in
// the UI (papaparse / read-excel-file, loaded on demand); this module works on a grid of strings.

export const TEMPLATE_COLUMNS = [
  'name_en',
  'name_ur',
  'category',
  'brand',
  'barcode',
  'sku',
  'price',
  'cost',
  'stock',
  'unit',
  'min_stock',
  'track_stock',
] as const;
export type ImportField = (typeof TEMPLATE_COLUMNS)[number];
export type Mapping = Partial<Record<ImportField, number>>;

export const MAX_IMPORT_ROWS = 5000;
/** Rows per Dexie transaction (≤ 200 sync ops: product + barcodes + opening movement). */
export const IMPORT_CHUNK = 50;
export const MAX_NAME = 120;
export const TEMPLATE_FILE = 'bikri-products-template.csv';

/**
 * Header names that map to each field, in English, Roman Urdu (common spellings) and Urdu
 * script, compared after `norm` (lower-case, no spaces, punctuation, brackets or a currency
 * suffix such as "(Rs)").
 */
const SYNONYMS: Record<ImportField, readonly string[]> = {
  name_en: [
    'nameen',
    'name',
    'productname',
    'product',
    'item',
    'itemname',
    'naam',
    'nam',
    'englishname',
    'naamenglish',
    'cheez',
    'cheezkanaam',
    'maalkanaam',
    'نام',
    'آئٹم',
    'چیز',
  ],
  name_ur: [
    'nameur',
    'urdu',
    'urduname',
    'urdunaam',
    'naamurdu',
    'urdumeinnaam',
    'اردونام',
    'ناماردو',
  ],
  category: [
    'category',
    'categoryname',
    'qisam',
    'qism',
    'group',
    'قسم',
    'کیٹیگری',
  ],
  brand: ['brand', 'company', 'make', 'kampani', 'برانڈ', 'کمپنی'],
  barcode: ['barcode', 'barcodes', 'ean', 'upc', 'barcod', 'بارکوڈ'],
  sku: ['sku', 'code', 'itemcode', 'productcode', 'کوڈ'],
  price: [
    'price',
    'saleprice',
    'sellingprice',
    'rate',
    'qeemat',
    'qimat',
    'keemat',
    'kimat',
    'qeematfarokht',
    'farokhtqeemat',
    'bechnekiqeemat',
    'retailprice',
    'قیمت',
    'قیمتفروخت',
    'ریٹ',
  ],
  cost: [
    'cost',
    'costprice',
    'purchaseprice',
    'laagat',
    'lagat',
    'buyprice',
    'khareed',
    'khareedqeemat',
    'qeematkhareed',
    'لاگت',
    'قیمتخرید',
    'خرید',
  ],
  stock: [
    'stock',
    'qty',
    'quantity',
    'openingstock',
    'onhand',
    'miqdar',
    'miqdaar',
    'tadaad',
    'tadad',
    'maal',
    'مقدار',
    'تعداد',
    'اسٹاک',
    'سٹاک',
  ],
  unit: ['unit', 'uom', 'ikai', 'اکائی', 'یونٹ'],
  min_stock: [
    'minstock',
    'lowstock',
    'minimum',
    'reorder',
    'alert',
    'lowstockalert',
    'kamazkam',
    'کمازکم',
  ],
  track_stock: ['trackstock', 'track'],
};

/** Lower-case letters and digits only (any script), without a currency suffix or BOM. */
const norm = (h: string) =>
  h
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/(?:rs|pkr|روپے)$/u, '');

/** The same without bracketed parts: "Qeemat (Rs)" → "qeemat". */
const normBare = (h: string) => norm(h.replace(/\([^)]*\)|\[[^\]]*\]/gu, ''));

/**
 * Matches headers to fields by English / Roman Urdu / Urdu names; each column used once.
 * Whole headers match first ("Naam (Urdu)" → name_ur), then without brackets.
 */
export function autoMap(headers: readonly string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const form of [norm, normBare]) {
    for (const field of TEMPLATE_COLUMNS) {
      if (mapping[field] !== undefined) continue;
      const index = headers.findIndex(
        (h, i) => !used.has(i) && SYNONYMS[field].includes(form(h)),
      );
      if (index >= 0) {
        mapping[field] = index;
        used.add(index);
      }
    }
  }
  return mapping;
}

function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\n\r]/u.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** `bikri-products-template.csv`: the header and one example row. */
export function templateCsv(): string {
  return toCsv([
    [...TEMPLATE_COLUMNS],
    [
      'Type-C cable 1 m',
      'ٹائپ سی کیبل',
      'Cables',
      'Anker',
      '8901234567890',
      '',
      '450',
      '300',
      '20',
      'pc',
      '5',
      'yes',
    ],
  ]);
}

export type ErrorCode =
  | 'name_required'
  | 'name_too_long'
  | 'price_required'
  | 'price_invalid'
  | 'cost_invalid'
  | 'stock_invalid'
  | 'unit_invalid'
  | 'min_stock_invalid'
  | 'track_invalid'
  | 'barcode_length'
  | 'barcode_taken'
  | 'barcode_repeat'
  | 'sku_repeat'
  | 'sku_taken'
  | 'too_many_rows';

export type RowError = {
  field: ImportField | 'row';
  code: ErrorCode;
  name?: string;
};

export type ParsedRow = {
  name_en: string;
  name_ur: string;
  category: string;
  brand: string;
  barcodes: string[];
  sku: string;
  price: number | null;
  cost: number | null;
  stock_milli: number | null;
  unit: string;
  /** The unit cell was filled (otherwise `unit` is the default `pc`). */
  unit_given: boolean;
  min_stock_milli: number | null;
  track_stock: boolean | null;
};

export type PreviewRow = {
  /** 1-based line in the sheet (the header is line 1). */
  line: number;
  cells: string[];
  action: 'new' | 'update' | 'error';
  productId: string | null;
  parsed: ParsedRow;
  errors: RowError[];
  /** Columns given for a matched product that the import does not apply. */
  ignored: ('stock' | 'cost')[];
};

export type ImportPreview = {
  headers: string[];
  rows: PreviewRow[];
  summary: { new: number; updates: number; errors: number };
};

const TRUE = new Set(['1', 'yes', 'y', 'true', 'haan', 'han', 'ha']);
const FALSE = new Set(['0', 'no', 'n', 'false', 'nahin', 'nahi', 'na']);

function cellOf(
  cells: readonly string[],
  mapping: Mapping,
  field: ImportField,
): string {
  const index = mapping[field];
  return index === undefined ? '' : String(cells[index] ?? '').trim();
}

function parseRow(
  cells: readonly string[],
  mapping: Mapping,
  errors: RowError[],
): ParsedRow {
  const get = (f: ImportField) => cellOf(cells, mapping, f);
  const unitRaw = get('unit').toLowerCase();
  const unit = unitRaw || 'pc';
  if (!isQtyUnit(unit)) errors.push({ field: 'unit', code: 'unit_invalid' });
  const qty = (raw: string, field: ImportField, code: ErrorCode) => {
    if (!raw) return null;
    const v = parseQtyToMilli(raw, isQtyUnit(unit) ? unit : 'pc');
    if (v === null || v < 0) {
      errors.push({ field, code });
      return null;
    }
    return v;
  };
  const money = (raw: string, field: ImportField, code: ErrorCode) => {
    if (!raw) return null;
    const v = parseMoneyToPaisa(raw);
    if (v === null) {
      errors.push({ field, code });
      return null;
    }
    return v;
  };
  const trackRaw = get('track_stock').toLowerCase();
  let track: boolean | null = null;
  if (trackRaw) {
    if (TRUE.has(trackRaw)) track = true;
    else if (FALSE.has(trackRaw)) track = false;
    else errors.push({ field: 'track_stock', code: 'track_invalid' });
  }
  const barcodes = get('barcode')
    .split(';')
    .map((b) => b.trim())
    .filter(Boolean);
  for (const b of barcodes) {
    if (b.length < 3 || b.length > 64)
      errors.push({ field: 'barcode', code: 'barcode_length' });
  }
  const name = get('name_en');
  if (name.length > MAX_NAME)
    errors.push({ field: 'name_en', code: 'name_too_long' });
  return {
    name_en: name,
    name_ur: get('name_ur'),
    category: get('category'),
    brand: get('brand'),
    barcodes: [...new Set(barcodes)],
    sku: get('sku'),
    price: money(get('price'), 'price', 'price_invalid'),
    cost: money(get('cost'), 'cost', 'cost_invalid'),
    stock_milli: qty(get('stock'), 'stock', 'stock_invalid'),
    unit,
    unit_given: unitRaw !== '',
    min_stock_milli: qty(get('min_stock'), 'min_stock', 'min_stock_invalid'),
    track_stock: track,
  };
}

/** Validates every row against this shop's products; nothing is written. */
export async function previewImport(
  db: BikriDb,
  grid: readonly (readonly string[])[],
  mapping: Mapping,
): Promise<ImportPreview> {
  const [headerRow, ...body] = grid;
  const headers = (headerRow ?? []).map((h) => String(h ?? ''));
  const products = (await db.products.toArray()).filter((p) => !p.deleted_at);
  const byId = new Map(products.map((p) => [p.id, p]));
  const bySku = new Map(products.map((p) => [String(p.sku ?? ''), p.id]));
  const byBarcode = new Map<string, string>();
  for (const b of await db.product_barcodes.toArray()) {
    if (!b.deleted_at && byId.has(String(b.product_id)))
      byBarcode.set(String(b.barcode), String(b.product_id));
  }
  const fileSkus = new Set<string>();
  const fileBarcodes = new Set<string>();
  const matched = new Set<string>();
  const rows: PreviewRow[] = [];
  body.forEach((raw, i) => {
    const cells = raw.map((c) => String(c ?? ''));
    if (cells.every((c) => c.trim() === '')) return;
    const errors: RowError[] = [];
    const line = i + 2;
    if (rows.length >= MAX_IMPORT_ROWS)
      errors.push({ field: 'row', code: 'too_many_rows' });
    const parsed = parseRow(cells, mapping, errors);
    let productId: string | null = parsed.sku
      ? (bySku.get(parsed.sku) ?? null)
      : null;
    // A SKU decides the match; only rows without one are matched by barcode.
    if (!parsed.sku) {
      for (const b of parsed.barcodes) {
        const owner = byBarcode.get(b);
        if (owner) {
          productId = owner;
          break;
        }
      }
    }
    for (const b of parsed.barcodes) {
      const owner = byBarcode.get(b);
      if (owner && owner !== productId) {
        errors.push({
          field: 'barcode',
          code: 'barcode_taken',
          name: String(byId.get(owner)?.name_en ?? ''),
        });
      } else if (fileBarcodes.has(b)) {
        errors.push({ field: 'barcode', code: 'barcode_repeat' });
      }
    }
    if (parsed.sku && fileSkus.has(parsed.sku))
      errors.push({ field: 'sku', code: 'sku_repeat' });
    if (productId && matched.has(productId))
      errors.push({ field: 'sku', code: 'sku_repeat' });
    if (!productId) {
      if (!parsed.name_en)
        errors.push({ field: 'name_en', code: 'name_required' });
      if (parsed.price === null && !errors.some((e) => e.field === 'price'))
        errors.push({ field: 'price', code: 'price_required' });
    }
    const ok = errors.length === 0;
    if (ok) {
      for (const b of parsed.barcodes) fileBarcodes.add(b);
      if (parsed.sku) fileSkus.add(parsed.sku);
      if (productId) matched.add(productId);
    }
    const ignored: ('stock' | 'cost')[] = [];
    if (productId) {
      if (parsed.stock_milli !== null) ignored.push('stock');
      if (parsed.cost !== null) ignored.push('cost');
    }
    rows.push({
      line,
      cells,
      action: ok ? (productId ? 'update' : 'new') : 'error',
      productId,
      parsed,
      errors,
      ignored,
    });
  });
  return {
    headers,
    rows,
    summary: {
      new: rows.filter((r) => r.action === 'new').length,
      updates: rows.filter((r) => r.action === 'update').length,
      errors: rows.filter((r) => r.action === 'error').length,
    },
  };
}

/** `import-errors.csv`: the skipped rows as they were, plus line and reason. */
export function errorsCsv(
  preview: ImportPreview,
  message: (e: RowError) => string,
): string {
  return toCsv([
    ['line', ...preview.headers, 'errors'],
    ...preview.rows
      .filter((r) => r.action === 'error')
      .map((r) => [
        String(r.line),
        ...r.cells,
        r.errors.map(message).join('; '),
      ]),
  ]);
}

export type ImportResult = {
  created: number;
  updated: number;
  skipped: number;
};

/**
 * Writes the valid rows in chunks of 50 per action. New products get their barcodes and, with
 * stock, an `opening` movement at the row's cost; matched products get the given fields and
 * any new barcodes (stock and cost are ignored). Unknown categories are created once.
 */
export async function runImport(
  db: BikriDb,
  preview: ImportPreview,
  ctx: LedgerContext,
  opts: WriteOptions & {
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ImportResult> {
  const valid = preview.rows.filter((r) => r.action !== 'error');
  const categories = new Map<string, string>();
  for (const c of await db.categories.toArray()) {
    if (!c.deleted_at)
      categories.set(
        String(c.name_en ?? '')
          .trim()
          .toLowerCase(),
        c.id,
      );
  }
  let sortOrder = (await db.categories.toArray()).reduce(
    (m, c) => Math.max(m, Number(c.sort_order ?? 0)),
    0,
  );
  const usedSkus = new Set(
    (await db.products.toArray()).map((p) => String(p.sku ?? '')),
  );
  const result: ImportResult = {
    created: 0,
    updated: 0,
    skipped: preview.summary.errors,
  };
  for (let start = 0; start < valid.length; start += IMPORT_CHUNK) {
    const chunk = valid.slice(start, start + IMPORT_CHUNK);
    await writeAction(
      db,
      async (w) => {
        const categoryId = async (name: string): Promise<string | null> => {
          const key = name.trim().toLowerCase();
          if (!key) return null;
          const known = categories.get(key);
          if (known) return known;
          sortOrder += 1;
          const row = await w.create('categories', {
            name_en: name.trim(),
            name_ur: '',
            color: 't1',
            sort_order: sortOrder,
          });
          categories.set(key, row.id);
          return row.id;
        };
        for (const r of chunk) {
          const p = r.parsed;
          if (r.action === 'new') {
            let sku = p.sku;
            while (!sku || usedSkus.has(sku)) sku = generateSku(p.name_en);
            usedSkus.add(sku);
            await createProduct(
              w,
              {
                name_en: p.name_en,
                name_ur: p.name_ur,
                brand: p.brand,
                category_id: await categoryId(p.category),
                sku,
                barcodes: p.barcodes,
                unit: p.unit,
                price: p.price ?? 0,
                cost: p.cost ?? 0,
                track_stock: p.track_stock ?? true,
                opening_milli: p.stock_milli ?? 0,
                min_stock_milli: p.min_stock_milli ?? 0,
              },
              ctx,
            );
            result.created += 1;
            continue;
          }
          const id = r.productId as string;
          const before = await w.table<MasterRow>('products').get(id);
          if (!before || before.deleted_at) continue;
          const patch: Record<string, string | number | null> = {};
          if (p.name_en) patch.name_en = p.name_en;
          if (p.name_ur) patch.name_ur = p.name_ur;
          if (p.brand) patch.brand = p.brand;
          if (p.category) patch.category_id = await categoryId(p.category);
          if (p.price !== null) patch.price = p.price;
          if (p.unit_given) patch.unit = p.unit;
          if (p.min_stock_milli !== null)
            patch.min_stock_milli = p.min_stock_milli;
          if (p.track_stock !== null) patch.track_stock = p.track_stock ? 1 : 0;
          await w.update('products', id, patch);
          if (p.price !== null && Number(before.price) !== p.price) {
            await productAudit(
              w,
              ctx,
              'price_change',
              id,
              { price: before.price },
              { price: p.price },
            );
          }
          const have = new Set(
            (
              await w
                .table<MasterRow>('product_barcodes')
                .where('product_id')
                .equals(id)
                .toArray()
            )
              .filter((b) => !b.deleted_at)
              .map((b) => String(b.barcode)),
          );
          for (const b of p.barcodes) {
            if (!have.has(b))
              await w.create('product_barcodes', {
                product_id: id,
                barcode: b,
              });
          }
          result.updated += 1;
        }
      },
      { actor: ctx.staff_id, ...opts },
    );
    opts.onProgress?.(
      Math.min(start + IMPORT_CHUNK, valid.length),
      valid.length,
    );
  }
  return result;
}

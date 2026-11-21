import type { MasterRow } from '@bikri/db';
import { describe, expect, it } from 'vitest';
import type { CatalogueMaster } from './catalogue.ts';
import { buildCatalogueIndex, patchCatalogueIndex } from './catalogue.ts';

const NOW = 1_700_000_000_000;

const product = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): MasterRow =>
  ({
    id,
    name_en: name,
    name_ur: '',
    sku: id,
    price: 10000,
    avg_cost: 5000,
    last_cost: 5000,
    track_stock: 1,
    min_stock_milli: 0,
    kind: 'simple',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    rev: 1,
    ...extra,
  }) as MasterRow;

const recipe = (
  id: string,
  bundleId: string,
  componentId: string,
  qty: number,
) =>
  ({
    id,
    bundle_id: bundleId,
    component_product_id: componentId,
    qty_milli: qty,
    sort_order: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    rev: 1,
  }) as MasterRow;

function master(): CatalogueMaster {
  return {
    products: [
      product('p1', 'Phone'),
      product('p2', 'Charger'),
      product('b1', 'Bundle A', { kind: 'bundle', track_stock: 0 }),
      product('b2', 'Bundle B', { kind: 'bundle', track_stock: 0 }),
    ],
    categories: new Map(),
    barcodes: new Map(),
    bundleItems: [
      recipe('bi1', 'b1', 'p1', 2000),
      recipe('bi2', 'b2', 'p2', 1000),
    ],
  };
}

const rowOf = (
  rows: ReturnType<typeof buildCatalogueIndex>['rows'],
  id: string,
) => rows.find((row) => row.product.id === id);

describe('catalogue stock patch (D-231)', () => {
  it('patches a component and only the bundles that use it', () => {
    const index = buildCatalogueIndex(
      master(),
      new Map([
        ['p1', 5000],
        ['p2', 9000],
      ]),
      new Map(),
      'avg',
    );
    expect(rowOf(index.rows, 'p1')?.onHand).toBe(5000);
    expect(rowOf(index.rows, 'b1')?.onHand).toBe(2000); // 5000 / 2 per bundle
    const b2Before = rowOf(index.rows, 'b2')?.bundle;

    const patched = patchCatalogueIndex(
      index,
      new Map([
        ['p1', 3000],
        ['p2', 9000],
      ]),
      'avg',
    );
    expect(patched).not.toBeNull();
    expect(rowOf(patched ?? [], 'p1')?.onHand).toBe(3000);
    expect(rowOf(patched ?? [], 'b1')?.onHand).toBe(1000); // 3000 / 2 per bundle
    expect(rowOf(patched ?? [], 'b1')?.stockState).toBe('ok');
    // The unrelated bundle keeps its row and bundle object.
    expect(rowOf(patched ?? [], 'b2')?.bundle).toBe(b2Before);
    // The patched array keeps the Sell order.
    expect(patched?.map((row) => row.product.id)).toEqual(
      index.rows.map((row) => row.product.id),
    );
  });

  it('returns the same array when no level changed and a full rebuild above 500', () => {
    const index = buildCatalogueIndex(
      master(),
      new Map([['p1', 5000]]),
      new Map(),
      'avg',
    );
    expect(patchCatalogueIndex(index, new Map([['p1', 5000]]), 'avg')).toBe(
      index.rows,
    );
    const many = new Map(
      Array.from({ length: 501 }, (_, i) => [`x${i}`, 1000] as const),
    );
    expect(patchCatalogueIndex(index, many, 'avg')).toBeNull();
  });
});

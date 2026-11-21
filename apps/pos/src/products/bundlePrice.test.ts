import type { MasterRow } from '@bikri/db';
import { describe, expect, it } from 'vitest';
import { bundleComponentsFromProducts } from './bundlePrice.ts';

function product(id: string, price = 10_000, cost = 5_000): MasterRow {
  return {
    id,
    name_en: id,
    price,
    avg_cost: cost,
    last_cost: cost,
  } as unknown as MasterRow;
}

describe('bundleComponentsFromProducts', () => {
  it('skips component products that are missing from the catalogue', () => {
    const { components, missing } = bundleComponentsFromProducts(
      [
        { component_product_id: 'a', qty_milli: 1000 },
        { component_product_id: 'gone', qty_milli: 2000 },
      ],
      [product('a')],
      'avg',
    );
    expect(components).toHaveLength(1);
    expect(missing).toEqual(['gone']);
  });

  it('returns no components for an unresolved catalogue and reports every id', () => {
    const { components, missing } = bundleComponentsFromProducts(
      [{ component_product_id: 'a', qty_milli: 1000 }],
      [],
      'last',
    );
    expect(components).toEqual([]);
    expect(missing).toEqual(['a']);
  });

  it('uses the shop cost method', () => {
    const row = { ...product('a'), avg_cost: 5000, last_cost: 7000 };
    expect(
      bundleComponentsFromProducts(
        [{ component_product_id: 'a', qty_milli: 1000 }],
        [row],
        'avg',
      ).components[0]?.unit_cost,
    ).toBe(5000);
    expect(
      bundleComponentsFromProducts(
        [{ component_product_id: 'a', qty_milli: 1000 }],
        [row],
        'last',
      ).components[0]?.unit_cost,
    ).toBe(7000);
  });
});

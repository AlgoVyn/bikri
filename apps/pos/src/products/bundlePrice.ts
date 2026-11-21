import type { MasterRow } from '@bikri/db';
import type { BundleItemInput } from '../data/catalog.ts';

export type BundleComponentCost = {
  qty_milli: number;
  unit_cost: number;
  unit_price: number;
};

/**
 * Recipe rows → `priceBundle` components. A saved recipe can outlive a component
 * product (soft-deleted, or a catalogue live query that has not resolved yet), so the
 * missing ids are returned separately instead of crashing `priceBundle` with an empty
 * list (UI-C2).
 */
export function bundleComponentsFromProducts(
  items: readonly BundleItemInput[],
  products: readonly MasterRow[],
  method: 'avg' | 'last',
): { components: BundleComponentCost[]; missing: string[] } {
  const byId = new Map(products.map((product) => [product.id, product]));
  const components: BundleComponentCost[] = [];
  const missing: string[] = [];
  for (const item of items) {
    const product = byId.get(item.component_product_id);
    if (product === undefined) {
      missing.push(item.component_product_id);
      continue;
    }
    components.push({
      qty_milli: item.qty_milli,
      unit_cost:
        method === 'last'
          ? Number(product.last_cost ?? 0)
          : Number(product.avg_cost ?? 0),
      unit_price: Number(product.price ?? 0),
    });
  }
  return { components, missing };
}

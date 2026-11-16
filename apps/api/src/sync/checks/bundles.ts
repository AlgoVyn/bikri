/**
 * Bundle sale and recipe checks (07 §6.2, D-229): split from applyOpsCheck so the
 * component-line, whole-bundle and recipe rules have one home. Called by `checkOp`.
 */
import type { Permission } from '@bikri/core';
import {
  key,
  type Lookups,
  overrideForLine,
  Reject,
} from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';

/** Active component ids of a bundle after the recipe ops in this push. */
export function activeBundleComponents(
  look: Lookups,
  group: PushOp[],
  bundleId: string,
): Set<string> {
  const components = new Set(
    (look.bundleRecipes.get(bundleId) ?? [])
      .filter((item) => item.deleted_at === null)
      .map((item) => item.component_product_id),
  );
  for (const candidate of group) {
    if (candidate.tbl !== 'bundle_items') continue;
    if (candidate.kind === 'delete') {
      const known =
        look.bundleItemById.get(String(candidate.row_id ?? '')) ??
        group.find(
          (row) =>
            row.tbl === 'bundle_items' &&
            row.kind !== 'delete' &&
            row.row?.id === candidate.row_id,
        )?.row;
      if (known && String(known.bundle_id) === bundleId)
        components.delete(String(known.component_product_id));
      continue;
    }
    if (
      candidate.row &&
      String(candidate.row.bundle_id) === bundleId &&
      candidate.row.deleted_at == null
    )
      components.add(String(candidate.row.component_product_id));
  }
  return components;
}

/** True when the product is deleted in this push or already deleted in D1. */
export function productDeletedInGroup(
  look: Lookups,
  group: PushOp[],
  productId: string,
): boolean {
  return (
    group.some(
      (candidate) =>
        candidate.tbl === 'products' &&
        candidate.kind === 'delete' &&
        candidate.row_id === productId,
    ) || look.current.get(key('products', productId))?.deleted_at != null
  );
}

const BUNDLE_FIELDS = [
  'bundle_id',
  'bundle_group',
  'bundle_name',
  'bundle_qty',
  'bundle_price',
  'bundle_discount',
  'bundle_component_qty_milli',
] as const;

/**
 * Bundle sale groups (04 §5): component lines only, all six fields set together,
 * same snapshot per group, quantity identity and group total. A fresh sale must match
 * the current recipe and bundle price; a stale/offline or reissued sale keeps its snapshot.
 */
export function checkBundleSaleGroups(
  look: Lookups,
  group: PushOp[],
  sale: Record<string, unknown>,
  lines: Record<string, unknown>[],
  entryAt: number,
  deviceSeenAt: number,
  allowed: (permission: Permission) => boolean,
): void {
  const n = (value: unknown) => Number(value ?? 0);
  const groups = new Map<string, Record<string, unknown>[]>();
  let bundleDiscountTotal = 0;
  for (const line of lines) {
    const set = BUNDLE_FIELDS.filter(
      (field) => line[field] !== null && line[field] !== undefined,
    ).length;
    if (set === 0) continue;
    if (set !== BUNDLE_FIELDS.length) throw new Reject('CONSTRAINT_FAILED');
    const bundleId = String(line.bundle_id);
    const bundleGroup = String(line.bundle_group);
    if (!bundleId || !bundleGroup || bundleId === line.product_id)
      throw new Reject('CONSTRAINT_FAILED');
    groups.set(bundleGroup, [...(groups.get(bundleGroup) ?? []), line]);
  }
  for (const bundleLines of groups.values()) {
    const first = bundleLines[0];
    if (!first) continue;
    const bundleId = String(first.bundle_id);
    const bundleQty = n(first.bundle_qty);
    const bundlePrice = n(first.bundle_price);
    const bundleDiscount = n(first.bundle_discount);
    const bundleName = String(first.bundle_name ?? '');
    bundleDiscountTotal += bundleDiscount * bundleQty;
    if (
      !Number.isSafeInteger(bundleQty) ||
      bundleQty <= 0 ||
      !Number.isSafeInteger(bundlePrice) ||
      bundlePrice < 0 ||
      !Number.isSafeInteger(bundleDiscount) ||
      bundleDiscount < 0 ||
      bundleDiscount > bundlePrice ||
      bundleName.length < 1 ||
      bundleName.length > 80
    )
      throw new Reject('CONSTRAINT_FAILED');
    let net = 0;
    const components = new Map<string, number>();
    for (const line of bundleLines) {
      if (
        line.bundle_id !== bundleId ||
        line.bundle_group !== first.bundle_group ||
        line.bundle_name !== first.bundle_name ||
        n(line.bundle_qty) !== bundleQty ||
        n(line.bundle_price) !== bundlePrice ||
        n(line.bundle_discount) !== bundleDiscount
      )
        throw new Reject('CONSTRAINT_FAILED');
      const perBundle = n(line.bundle_component_qty_milli);
      if (
        !Number.isSafeInteger(perBundle) ||
        perBundle <= 0 ||
        n(line.qty_milli) !== perBundle * bundleQty
      )
        throw new Reject('CONSTRAINT_FAILED');
      const productId = String(line.product_id ?? '');
      if (!productId || components.has(productId))
        throw new Reject('CONSTRAINT_FAILED');
      components.set(productId, perBundle);
      net += n(line.net);
    }
    if (net !== (bundlePrice - bundleDiscount) * bundleQty)
      throw new Reject('CONSTRAINT_FAILED');

    const pushedProduct = group.find(
      (candidate) =>
        candidate.tbl === 'products' &&
        candidate.kind !== 'delete' &&
        candidate.row?.id === bundleId,
    )?.row;
    const product = pushedProduct ?? look.products.get(bundleId);
    if (!product || String(product.kind ?? 'simple') !== 'bundle')
      throw new Reject('CONSTRAINT_FAILED');

    const fresh =
      !sale.replaces_sale_id &&
      (pushedProduct !== undefined ||
        (entryAt >= Number(product.updated_at) &&
          Number(product.updated_at) <= deviceSeenAt));
    if (fresh) {
      if (
        bundlePrice < Number(product.price) &&
        !allowed('catalog.edit') &&
        !bundleLines.some((line) =>
          overrideForLine(
            look,
            group,
            'sales',
            String(sale.id),
            String(line.id),
            bundlePrice,
          ),
        )
      )
        throw new Reject('FORBIDDEN');
      const recipe = (look.bundleRecipes.get(bundleId) ?? []).filter(
        (item) => item.deleted_at === null,
      );
      if (recipe.length < 1 || recipe.length > 20)
        throw new Reject('CONSTRAINT_FAILED');
      if (recipe.length !== components.size)
        throw new Reject('CONSTRAINT_FAILED');
      for (const item of recipe) {
        if (components.get(item.component_product_id) !== item.qty_milli)
          throw new Reject('CONSTRAINT_FAILED');
      }
    }
  }
  if (
    sale.bundle_discount_total !== undefined &&
    n(sale.bundle_discount_total) !== bundleDiscountTotal
  )
    throw new Reject('CONSTRAINT_FAILED');
}

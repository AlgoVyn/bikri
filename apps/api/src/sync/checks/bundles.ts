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
  return new Set(activeBundleRecipe(look, group, bundleId).keys());
}

/**
 * Active recipe of a bundle after the recipe ops in this push: component product id →
 * quantity per bundle. A delete has no row payload, so it is resolved through the stored
 * row (which used to be dead code and made a 20→20 swap count 21).
 */
export function activeBundleRecipe(
  look: Lookups,
  group: PushOp[],
  bundleId: string,
): Map<string, number> {
  const recipe = new Map<string, number>();
  for (const item of look.bundleRecipes.get(bundleId) ?? [])
    if (item.deleted_at === null)
      recipe.set(item.component_product_id, item.qty_milli);
  for (const candidate of group) {
    if (candidate.tbl !== 'bundle_items') continue;
    const softDeleted =
      candidate.kind === 'upsert' &&
      candidate.row?.deleted_at !== null &&
      candidate.row?.deleted_at !== undefined;
    if (candidate.kind === 'delete' || softDeleted) {
      const known =
        (candidate.kind === 'upsert' ? candidate.row : undefined) ??
        look.bundleItemById.get(String(candidate.row_id ?? '')) ??
        group.find(
          (row) =>
            row.tbl === 'bundle_items' &&
            row.kind !== 'delete' &&
            row.row?.id === candidate.row_id,
        )?.row;
      if (known && String(known.bundle_id) === bundleId)
        recipe.delete(String(known.component_product_id));
      continue;
    }
    if (
      candidate.row &&
      String(candidate.row.bundle_id) === bundleId &&
      candidate.row.deleted_at == null
    )
      recipe.set(
        String(candidate.row.component_product_id),
        Number(candidate.row.qty_milli ?? 0),
      );
  }
  return recipe;
}

/** True when the product is deleted in this push or already deleted in D1. */
export function productDeletedInGroup(
  look: Lookups,
  group: PushOp[],
  productId: string,
): boolean {
  return (
    look.bundleDeleted.has(productId) ||
    group.some(
      (candidate) =>
        candidate.tbl === 'products' &&
        candidate.kind === 'delete' &&
        candidate.row_id === productId,
    ) ||
    look.current.get(key('products', productId))?.deleted_at != null
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

    // API-M2: the recipe is fresh only when every stored row of it (including one that
    // was soft-deleted) was already visible to this device and does not postdate the sale.
    // Otherwise the snapshot the till sold is authoritative, exactly like the product row.
    const recipeSeen = (look.bundleRecipeHistory.get(bundleId) ?? []).every(
      (item) =>
        item.updated_at <= deviceSeenAt &&
        (item.deleted_at === null
          ? entryAt >= item.updated_at
          : entryAt >= item.deleted_at),
    );
    const fresh =
      !sale.replaces_sale_id &&
      recipeSeen &&
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
      // The recipe after this push's own recipe ops, not only the stored one: creating a
      // bundle and selling it in one push must see the new components (API-M2).
      const recipe = activeBundleRecipe(look, group, bundleId);
      if (recipe.size < 1 || recipe.size > 20)
        throw new Reject('CONSTRAINT_FAILED');
      if (recipe.size !== components.size)
        throw new Reject('CONSTRAINT_FAILED');
      for (const [productId, qty] of recipe) {
        if (components.get(productId) !== qty)
          throw new Reject('CONSTRAINT_FAILED');
      }
    }
  }
  if (sale.replaces_sale_id) checkReissuedBundleGroups(look, sale, groups);
  if (
    sale.bundle_discount_total !== undefined &&
    n(sale.bundle_discount_total) !== bundleDiscountTotal
  )
    throw new Reject('CONSTRAINT_FAILED');
}

/** The replacement bill's bundle groups, same bundle and same snapshot as the replaced bill. */
function checkReissuedBundleGroups(
  look: Lookups,
  sale: Record<string, unknown>,
  groups: Map<string, Record<string, unknown>[]>,
): void {
  const replacedId = String(sale.replaces_sale_id);
  const replacedGroups = new Map<string, Record<string, unknown>[]>();
  for (const line of look.saleLinesBySale.get(replacedId) ?? []) {
    if (typeof line.bundle_group !== 'string') continue;
    replacedGroups.set(line.bundle_group, [
      ...(replacedGroups.get(line.bundle_group) ?? []),
      line as unknown as Record<string, unknown>,
    ]);
  }
  if (replacedGroups.size === 0) return;
  const signature = (lines: Record<string, unknown>[]): string => {
    const first = lines[0] ?? {};
    const components = lines
      .map(
        (line) =>
          `${String(line.product_id)}:${Number(line.bundle_component_qty_milli)}`,
      )
      .sort()
      .join(',');
    return [
      String(first.bundle_id),
      String(first.bundle_name ?? ''),
      Number(first.bundle_qty ?? 0),
      Number(first.bundle_price ?? 0),
      Number(first.bundle_discount ?? 0),
      components,
    ].join('|');
  };
  const expected = [...replacedGroups.values()].map(signature).sort();
  const actual = [...groups.values()].map(signature).sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  )
    throw new Reject('CONSTRAINT_FAILED');
}

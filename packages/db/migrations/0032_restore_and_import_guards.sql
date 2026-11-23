-- 0032_restore_and_import_guards.sql
--
-- Restore-safe bundle triggers (CORE-H1/H2) and operator-import backstops for
-- sale lines and expenses (CORE-L2) from the 2026-11-23 review.
-- Trigger-only: no column, wire shape or API change; SCHEMA_VERSION stays 8.

-- CORE-H1. 0030 created the INSERT-side recipe guards without
-- `NEW.deleted_at IS NULL`. The operator import replays every exported row,
-- including soft-deleted historical `bundle_items`, so a shop that removed a
-- component and later converted that component to a bundle aborted the restore
-- with 'a bundle cannot contain another bundle'. History is immutable: only an
-- active recipe row must satisfy the no-nesting rules. 0031 already made the
-- UPDATE variants and the parent-kind INSERT trigger deleted_at-aware.
DROP TRIGGER bundle_items_no_self;

CREATE TRIGGER bundle_items_no_self
BEFORE INSERT ON bundle_items
WHEN NEW.deleted_at IS NULL AND NEW.bundle_id = NEW.component_product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain itself');
END;

DROP TRIGGER bundle_items_no_nested;

CREATE TRIGGER bundle_items_no_nested
BEFORE INSERT ON bundle_items
WHEN NEW.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.component_product_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain another bundle');
END;

-- CORE-H2. 0031 sets `cost_changed_at` on zero-movement simple products with a
-- catalogue cost so every till pulls the repaired average. It then reused
-- `cost_changed_at <> 0` as a proxy for "has stock movements", which made those
-- same products impossible to convert to bundles. Actual stock is fully
-- described by the cached on-hand quantity and the movement rows, so keep those
-- two checks and drop the proxy. The movement lookup is unindexed since 0021
-- dropped `stock_movements_product`; it runs only on the rare simple -> bundle
-- transition, while re-adding the index would tax every stock movement write.
DROP TRIGGER products_bundle_stock_movements;

CREATE TRIGGER products_bundle_stock_movements
BEFORE UPDATE OF kind ON products
WHEN NEW.kind = 'bundle'
  AND OLD.kind <> 'bundle'
  AND (
    OLD.on_hand_milli <> 0
    OR EXISTS (
      SELECT 1 FROM stock_movements m
      WHERE m.tenant_id = NEW.tenant_id AND m.product_id = NEW.id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot have a stock movement');
END;

-- CORE-L2. `sale_lines` is append-only and the sync checks run only on new
-- pushes; the operator import writes rows directly. A bundle is never a sale
-- line (D-229), and the 0017 bundle metadata on a component line is either
-- complete or absent (04 §5). A component line may name a product that became a
-- bundle after the sale (the history CORE-H1 restores), so the product-kind
-- guard judges the product state at the line's time: `products.updated_at >
-- sale_lines.created_at` means the product changed after the line was rung. A
-- line rung while its product was already a bundle is rejected.
CREATE TRIGGER sale_lines_no_bundle_product
BEFORE INSERT ON sale_lines
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.product_id
    AND p.kind = 'bundle'
    AND p.updated_at <= NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a sale line');
END;

CREATE TRIGGER sale_lines_bundle_not_self
BEFORE INSERT ON sale_lines
WHEN NEW.bundle_id IS NOT NULL AND NEW.bundle_id = NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle sale line cannot use the bundle as its component');
END;

-- The six 0017 columns form one component-line group: all set or all null.
-- `bundle_discount` arrived in 0018 and is deliberately not part of this group,
-- so a historical line written between 0017 and 0018 still restores; when it is
-- present it needs a bundle price, and the 0030 trigger still bounds it.
CREATE TRIGGER sale_lines_bundle_metadata_complete
BEFORE INSERT ON sale_lines
WHEN (
    NEW.bundle_id IS NOT NULL
    OR NEW.bundle_group IS NOT NULL
    OR NEW.bundle_name IS NOT NULL
    OR NEW.bundle_qty IS NOT NULL
    OR NEW.bundle_price IS NOT NULL
    OR NEW.bundle_component_qty_milli IS NOT NULL
  )
  AND (
    NEW.bundle_id IS NULL
    OR NEW.bundle_group IS NULL
    OR NEW.bundle_name IS NULL
    OR NEW.bundle_qty IS NULL
    OR NEW.bundle_price IS NULL
    OR NEW.bundle_component_qty_milli IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'bundle sale line metadata must be complete');
END;

CREATE TRIGGER sale_lines_bundle_discount_needs_group
BEFORE INSERT ON sale_lines
WHEN NEW.bundle_discount IS NOT NULL
  AND (
    NEW.bundle_id IS NULL
    OR NEW.bundle_group IS NULL
    OR NEW.bundle_price IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle discount needs a bundle group and price');
END;

-- CORE-L2. The Worker and the till already refuse these, but the operator
-- import inserts directly. `expenses_one_reversal` still stops a second reversal
-- of the same expense; these guards stop a row reversing itself and a negative
-- row reversing another negative row, which would make the ledger totals depend
-- on reversal order.
CREATE TRIGGER expenses_no_self_reversal
BEFORE INSERT ON expenses
WHEN NEW.reverses_id IS NOT NULL AND NEW.reverses_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'an expense cannot reverse itself');
END;

CREATE TRIGGER expenses_no_chained_reversal
BEFORE INSERT ON expenses
WHEN NEW.reverses_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM expenses e
    WHERE e.tenant_id = NEW.tenant_id
      AND e.id = NEW.reverses_id
      AND e.reverses_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'an expense reversal cannot be reversed');
END;

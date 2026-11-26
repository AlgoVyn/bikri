-- 0038_quote_guards.sql
--
-- CORE-M3 from the 2026-11-27 whole-codebase review: DB-level import backstops
-- for quotations/quotation_lines. The push path already validates these in
-- checks/quotes.ts; the operator `/import` path writes rows directly, so the
-- constraints below keep a malformed backup from creating a quote that every
-- later till edit must reject.

CREATE TRIGGER quotations_round_total_to_insert
BEFORE INSERT ON quotations
WHEN NEW.round_total_to NOT IN (1, 100, 500, 1000)
BEGIN
  SELECT RAISE(ABORT, 'round_total_to must be 1, 100, 500 or 1000');
END;

CREATE TRIGGER quotations_round_total_to_update
BEFORE UPDATE OF round_total_to ON quotations
WHEN NEW.round_total_to NOT IN (1, 100, 500, 1000)
BEGIN
  SELECT RAISE(ABORT, 'round_total_to must be 1, 100, 500 or 1000');
END;

-- A quote line is either a simple/component line or a complete bundle snapshot.
-- `bundle_discount` is NOT NULL DEFAULT 0, so it is validated separately.
CREATE TRIGGER quotation_lines_bundle_metadata_complete_insert
BEFORE INSERT ON quotation_lines
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
  SELECT RAISE(ABORT, 'incomplete quotation bundle metadata');
END;

CREATE TRIGGER quotation_lines_bundle_metadata_complete_update
BEFORE UPDATE ON quotation_lines
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
  SELECT RAISE(ABORT, 'incomplete quotation bundle metadata');
END;

CREATE TRIGGER quotation_lines_bundle_discount_needs_group_insert
BEFORE INSERT ON quotation_lines
WHEN NEW.bundle_discount != 0 AND NEW.bundle_group IS NULL
BEGIN
  SELECT RAISE(ABORT, 'bundle_discount needs a bundle group');
END;

CREATE TRIGGER quotation_lines_bundle_discount_needs_group_update
BEFORE UPDATE ON quotation_lines
WHEN NEW.bundle_discount != 0 AND NEW.bundle_group IS NULL
BEGIN
  SELECT RAISE(ABORT, 'bundle_discount needs a bundle group');
END;

CREATE TRIGGER quotation_lines_bundle_discount_bound_insert
BEFORE INSERT ON quotation_lines
WHEN NEW.bundle_price IS NOT NULL AND NEW.bundle_discount > NEW.bundle_price
BEGIN
  SELECT RAISE(ABORT, 'bundle_discount exceeds bundle_price');
END;

CREATE TRIGGER quotation_lines_bundle_discount_bound_update
BEFORE UPDATE ON quotation_lines
WHEN NEW.bundle_price IS NOT NULL AND NEW.bundle_discount > NEW.bundle_price
BEGIN
  SELECT RAISE(ABORT, 'bundle_discount exceeds bundle_price');
END;

CREATE TRIGGER quotation_lines_bundle_not_self_insert
BEFORE INSERT ON quotation_lines
WHEN NEW.bundle_id IS NOT NULL AND NEW.bundle_id = NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be its own component');
END;

CREATE TRIGGER quotation_lines_bundle_not_self_update
BEFORE UPDATE ON quotation_lines
WHEN NEW.bundle_id IS NOT NULL AND NEW.bundle_id = NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be its own component');
END;

-- A standalone line must not point at a bundle product; bundle components carry
-- `bundle_id`. This mirrors sale_lines_no_bundle_product on the sale path.
CREATE TRIGGER quotation_lines_no_bundle_product_insert
BEFORE INSERT ON quotation_lines
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.product_id
    AND p.kind = 'bundle'
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a quotation line');
END;

CREATE TRIGGER quotation_lines_no_bundle_product_update
BEFORE UPDATE OF product_id ON quotation_lines
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.product_id
    AND p.kind = 'bundle'
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a quotation line');
END;

-- `bundle_id` has no composite FK in 0036; require a tenant-scoped bundle product.
CREATE TRIGGER quotation_lines_bundle_exists_insert
BEFORE INSERT ON quotation_lines
WHEN NEW.bundle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.bundle_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'quotation bundle_id is not a bundle product');
END;

CREATE TRIGGER quotation_lines_bundle_exists_update
BEFORE UPDATE OF bundle_id ON quotation_lines
WHEN NEW.bundle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.bundle_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'quotation bundle_id is not a bundle product');
END;

-- 0031_review_followup.sql
--
-- Follow-up to 0030. Production already recorded 0030 as applied before its
-- cost-repair predicate and bundle trigger were corrected, so those changes must
-- ship as a new migration. The 0030 json_object split is for fresh databases only;
-- this file is the authoritative repair for existing shops.
--
-- Additive only: no column, wire shape or API change.

-- CORE-H1. 0024 initialised avg_cost from the catalogue cost for products with no
-- stock movement, but did not bump rev, write change_log or set cost_changed_at.
-- 0030 filtered `avg_cost = 0`, which matches none of those rows. Repair every
-- simple product whose catalogue cost is known and was never published, and keep
-- updated_at stable so the change_log row and the product row agree.
INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at)
SELECT
  p.tenant_id,
  'products',
  p.id,
  'upsert',
  json_insert(
    json_object(
      'id', p.id,
      'name_en', p.name_en,
      'name_ur', p.name_ur,
      'brand', p.brand,
      'category_id', p.category_id,
      'sku', p.sku,
      'unit', p.unit,
      'price', p.price,
      'last_cost', p.last_cost,
      'avg_cost', p.last_cost,
      'min_stock_milli', p.min_stock_milli,
      'track_stock', p.track_stock,
      'tax_rate_bp', p.tax_rate_bp,
      'track_serial', p.track_serial,
      'warranty_days', p.warranty_days,
      'pack_size_milli', p.pack_size_milli
    ),
    'image_key', p.image_key,
    'notes', p.notes,
    'created_at', p.created_at,
    'updated_at', p.updated_at,
    'deleted_at', p.deleted_at,
    'rev', p.rev + 1,
    'updated_by', p.updated_by,
    'kind', p.kind
  ),
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM products p
WHERE (p.avg_cost = 0 OR p.avg_cost = p.last_cost)
  AND p.last_cost > 0
  AND p.kind = 'simple'
  AND p.cost_changed_at = 0;

UPDATE products
SET
  avg_cost = last_cost,
  rev = rev + 1,
  cost_changed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE (avg_cost = 0 OR avg_cost = last_cost)
  AND last_cost > 0
  AND kind = 'simple'
  AND cost_changed_at = 0;

-- CORE-H2. 0030's trigger was AFTER INSERT, where a stock movement cannot yet exist,
-- so it never blocked simple -> bundle and scanned stock_movements on every bundle
-- creation. Check the transition itself and inspect the old product state.
DROP TRIGGER IF EXISTS products_bundle_stock_movements;
CREATE TRIGGER products_bundle_stock_movements
BEFORE UPDATE OF kind ON products
WHEN NEW.kind = 'bundle'
  AND OLD.kind <> 'bundle'
  AND (
    OLD.on_hand_milli <> 0
    OR OLD.cost_changed_at <> 0
    OR EXISTS (
      SELECT 1 FROM stock_movements m
      WHERE m.tenant_id = NEW.tenant_id AND m.product_id = NEW.id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot have a stock movement');
END;

-- CORE-M1. A bundle_items row must belong to a product that is actually a bundle;
-- the sync check enforces this, but the operator import path relies on triggers.
CREATE TRIGGER bundle_items_parent_kind_insert
BEFORE INSERT ON bundle_items
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.bundle_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle item must belong to a bundle');
END;

DROP TRIGGER IF EXISTS bundle_items_parent_kind_update;
CREATE TRIGGER bundle_items_parent_kind_update
BEFORE UPDATE OF bundle_id, deleted_at ON bundle_items
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.bundle_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle item must belong to a bundle');
END;

DROP TRIGGER IF EXISTS bundle_items_no_self_update;
CREATE TRIGGER bundle_items_no_self_update
BEFORE UPDATE OF bundle_id, component_product_id, deleted_at ON bundle_items
WHEN NEW.deleted_at IS NULL AND NEW.bundle_id = NEW.component_product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain itself');
END;

DROP TRIGGER IF EXISTS bundle_items_no_nested_update;
CREATE TRIGGER bundle_items_no_nested_update
BEFORE UPDATE OF bundle_id, component_product_id, deleted_at ON bundle_items
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

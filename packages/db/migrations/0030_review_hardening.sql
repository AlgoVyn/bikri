-- 0030_review_hardening.sql
--
-- Data repair and database-level backstops from the 2026-11-21 review.
-- Additive only: no column, wire shape or API change.

-- CORE-H1. `0024` initialised `products.avg_cost` from the catalogue cost for products
-- with no stock movement, but it did not bump `rev`, write a `change_log` row or set
-- `cost_changed_at`. Tills that had already pulled `avg_cost = 0` therefore kept the old
-- value and their next sale failed the cost check forever. Repair every remaining row
-- and publish the change.
--
-- The predicate is deliberately `cost_changed_at = 0` rather than a `NOT EXISTS` scan
-- over stock_movements: `0021` dropped the per-product movement index, so a scan would
-- be O(products x movements) during a production deploy. A costed receipt leaves a
-- derived non-zero average, and the normal client writes null `unit_cost` on a count,
-- refund or damage row, so `cost_changed_at = 0` covers the affected rows; a rare
-- non-costed movement with a unit cost is repaired on the next product edit.
INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at)
SELECT
  p.tenant_id,
  'products',
  p.id,
  'upsert',
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
    'pack_size_milli', p.pack_size_milli,
    'image_key', p.image_key,
    'notes', p.notes,
    'created_at', p.created_at,
    'updated_at', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    'deleted_at', p.deleted_at,
    'rev', p.rev + 1,
    'updated_by', p.updated_by,
    'kind', p.kind
  ),
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM products p
WHERE p.avg_cost = 0
  AND p.last_cost > 0
  AND p.kind = 'simple'
  AND p.cost_changed_at = 0;

UPDATE products
SET
  avg_cost = last_cost,
  rev = rev + 1,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  cost_changed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE avg_cost = 0
  AND last_cost > 0
  AND kind = 'simple'
  AND cost_changed_at = 0;

-- CORE-M2. `cost_changed_at` must only advance for a costed receipt: a count, refund or
-- damage row with a unit_cost must not make another till's sale look "known" and then
-- skip its cost verification. Also refuse a negative movement cost at the boundary.
DROP TRIGGER products_stock_after_movement;
CREATE TRIGGER products_stock_after_movement
AFTER INSERT ON stock_movements
BEGIN
  UPDATE products
  SET
    on_hand_milli = on_hand_milli + NEW.qty_delta_milli,
    cost_changed_at = CASE
      WHEN NEW.qty_delta_milli > 0
        AND NEW.unit_cost IS NOT NULL
        AND NEW.unit_cost >= 0
        AND NEW.reason_code IN (
          'opening', 'purchase', 'received_godown', 'received_local', 'received_other'
        )
        THEN MAX(cost_changed_at, NEW.created_at)
      ELSE cost_changed_at
    END
  WHERE tenant_id = NEW.tenant_id AND id = NEW.product_id;
END;

CREATE TRIGGER stock_movements_unit_cost_non_negative
BEFORE INSERT ON stock_movements
WHEN NEW.unit_cost IS NOT NULL AND NEW.unit_cost < 0
BEGIN
  SELECT RAISE(ABORT, 'stock movement cost must be non-negative');
END;

-- CORE-M4. Bundle invariants that previously lived only in checkOp; the operator import
-- path and direct migrations must not be able to create an invalid bundle.
CREATE TRIGGER bundle_items_no_self
BEFORE INSERT ON bundle_items
WHEN NEW.bundle_id = NEW.component_product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain itself');
END;

CREATE TRIGGER bundle_items_no_self_update
BEFORE UPDATE OF bundle_id, component_product_id ON bundle_items
WHEN NEW.bundle_id = NEW.component_product_id
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain itself');
END;

CREATE TRIGGER bundle_items_no_nested
BEFORE INSERT ON bundle_items
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.component_product_id
    AND p.kind = 'bundle'
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain another bundle');
END;

CREATE TRIGGER bundle_items_no_nested_update
BEFORE UPDATE OF bundle_id, component_product_id ON bundle_items
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.component_product_id
    AND p.kind = 'bundle'
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot contain another bundle');
END;

CREATE TRIGGER products_bundle_track_stock_insert
BEFORE INSERT ON products
WHEN NEW.kind = 'bundle' AND NEW.track_stock <> 0
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot track stock');
END;

CREATE TRIGGER products_bundle_track_stock_update
BEFORE UPDATE OF kind, track_stock ON products
WHEN NEW.kind = 'bundle' AND NEW.track_stock <> 0
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot track stock');
END;

CREATE TRIGGER products_bundle_kind_recipe
AFTER UPDATE OF kind ON products
WHEN NEW.kind <> 'bundle'
  AND EXISTS (
    SELECT 1 FROM bundle_items b
    WHERE b.tenant_id = NEW.tenant_id
      AND b.bundle_id = NEW.id
      AND b.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle with an active recipe cannot become simple');
END;

CREATE TRIGGER products_component_bundle_kind
AFTER UPDATE OF kind ON products
WHEN NEW.kind = 'bundle'
  AND EXISTS (
    SELECT 1 FROM bundle_items b
    WHERE b.tenant_id = NEW.tenant_id
      AND b.component_product_id = NEW.id
      AND b.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'a component of an active bundle cannot become a bundle');
END;

CREATE TRIGGER stock_movements_no_bundle
BEFORE INSERT ON stock_movements
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.product_id
    AND p.kind = 'bundle'
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot have a stock movement');
END;

CREATE TRIGGER products_bundle_stock_movements
AFTER INSERT ON products
WHEN NEW.kind = 'bundle'
  AND EXISTS (
    SELECT 1 FROM stock_movements m
    WHERE m.tenant_id = NEW.tenant_id AND m.product_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot have a stock movement');
END;

CREATE TRIGGER sale_lines_bundle_discount_bound
BEFORE INSERT ON sale_lines
WHEN NEW.bundle_discount IS NOT NULL
  AND NEW.bundle_price IS NOT NULL
  AND NEW.bundle_discount > NEW.bundle_price
BEGIN
  SELECT RAISE(ABORT, 'a bundle discount cannot exceed the bundle price');
END;

CREATE TRIGGER change_log_watermarks_max_seq_insert
BEFORE INSERT ON change_log_watermarks
WHEN NEW.max_seq < 0
BEGIN
  SELECT RAISE(ABORT, 'a change log watermark cannot be negative');
END;

CREATE TRIGGER change_log_watermarks_max_seq_update
BEFORE UPDATE OF max_seq ON change_log_watermarks
WHEN NEW.max_seq < 0
BEGIN
  SELECT RAISE(ABORT, 'a change log watermark cannot be negative');
END;

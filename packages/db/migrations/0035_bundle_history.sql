-- 0035_bundle_history.sql
--
-- CORE-M1/CORE-M2 from the 2026-11-25 whole-codebase review:
--   * drop the redundant partial `bundle_items_lookup` index (0033 added the
--     non-partial `bundle_items_by_component` on the same key columns);
--   * record `bundle_since` so the import guard can distinguish a historical
--     simple-product sale from a synthetic bundle sale line without being fooled
--     by any later product edit (and without aborting a restore when a till clock
--     ran slightly ahead).
--
-- `bundle_since` is server-only: the API hides it from client columns and rejects
-- it in a pushed row. Schema changes bump SCHEMA_VERSION and CLIENT_SCHEMA_VERSION
-- to 9; MIN_CLIENT_SCHEMA stays at 1 because the client wire shape is unchanged.

ALTER TABLE products ADD COLUMN bundle_since INTEGER;

UPDATE products
SET bundle_since = updated_at
WHERE kind = 'bundle';

-- The pending/app-version report is throttled separately from the download
-- freshness watermark, so a device with an old `last_seen_at` does not write on
-- every request. Start existing devices from their last known activity.
ALTER TABLE devices ADD COLUMN last_report_at INTEGER;

UPDATE devices
SET last_report_at = COALESCE(last_seen_at, updated_at, 0);

DROP INDEX IF EXISTS bundle_items_lookup;

DROP TRIGGER sale_lines_no_bundle_product;

CREATE TRIGGER sale_lines_no_bundle_product
BEFORE INSERT ON sale_lines
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.tenant_id = NEW.tenant_id
    AND p.id = NEW.product_id
    AND p.kind = 'bundle'
    AND COALESCE(p.bundle_since, p.updated_at) <= NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a sale line');
END;

-- A bundle inserted directly (operator import or setup) starts at its last edit.
-- Backups do not carry the server-only `bundle_since`, so using `created_at` here
-- would make a restored converted product reject its historical simple sales;
-- `updated_at` is included in backups and is never earlier than the conversion.
CREATE TRIGGER products_bundle_since_insert
AFTER INSERT ON products
WHEN NEW.kind = 'bundle' AND NEW.bundle_since IS NULL
BEGIN
  UPDATE products
  SET bundle_since = CASE
    WHEN NEW.updated_at > 0 THEN NEW.updated_at
    ELSE NEW.created_at
  END
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER products_bundle_since_update
AFTER UPDATE OF kind ON products
WHEN NEW.kind = 'bundle' AND OLD.kind <> 'bundle'
BEGIN
  UPDATE products
  SET bundle_since = CASE
    WHEN NEW.updated_at > 0 THEN NEW.updated_at
    ELSE NEW.created_at
  END
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

CREATE TRIGGER products_bundle_since_clear
AFTER UPDATE OF kind ON products
WHEN NEW.kind <> 'bundle'
BEGIN
  UPDATE products
  SET bundle_since = NULL
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

UPDATE meta SET value = '9' WHERE key = 'schema_version';

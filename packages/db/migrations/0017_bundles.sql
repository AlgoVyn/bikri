-- 0017_bundles.sql
--
-- A bundle is a product row with kind='bundle', track_stock=0 and a fixed recipe.
-- The sale is expanded into ordinary component sale_lines; the bundle product
-- never becomes a sale line and never gets a stock movement.
ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'simple'
  CHECK (kind IN ('simple','bundle'));
CREATE INDEX products_kind ON products (tenant_id, kind);

CREATE TABLE bundle_items (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  bundle_id           TEXT NOT NULL,
  component_product_id TEXT NOT NULL,
  qty_milli           INTEGER NOT NULL CHECK (qty_milli > 0),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  rev                 INTEGER NOT NULL DEFAULT 1,
  updated_by          TEXT,
  FOREIGN KEY (tenant_id, bundle_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, component_product_id) REFERENCES products(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX bundle_items_component
  ON bundle_items (tenant_id, bundle_id, component_product_id)
  WHERE deleted_at IS NULL;
CREATE INDEX bundle_items_lookup
  ON bundle_items (tenant_id, component_product_id)
  WHERE deleted_at IS NULL;

-- sale_lines: bundle metadata. All null for a normal or quick-sale line.
-- The all-or-none group, qty identity and group totals are checked by checkOp;
-- a composite FK on bundle_id is deliberately not added (see the note above).
ALTER TABLE sale_lines ADD COLUMN bundle_id TEXT;
ALTER TABLE sale_lines ADD COLUMN bundle_group TEXT;
ALTER TABLE sale_lines ADD COLUMN bundle_name TEXT
  CHECK (bundle_name IS NULL OR length(bundle_name) BETWEEN 1 AND 80);
ALTER TABLE sale_lines ADD COLUMN bundle_qty INTEGER
  CHECK (bundle_qty IS NULL OR bundle_qty > 0);
ALTER TABLE sale_lines ADD COLUMN bundle_price INTEGER
  CHECK (bundle_price IS NULL OR bundle_price >= 0);
ALTER TABLE sale_lines ADD COLUMN bundle_component_qty_milli INTEGER
  CHECK (bundle_component_qty_milli IS NULL OR bundle_component_qty_milli > 0);

UPDATE meta SET value = '4' WHERE key = 'schema_version';

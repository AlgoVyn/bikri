-- D-301 / 24 Nov review L6: the push bundle lookup reads soft-deleted recipe rows
-- (to tell a stored recipe from the one the till sold), so the existing partial
-- `bundle_items_component`/`bundle_items_lookup` indexes cannot serve it. These
-- non-partial indexes avoid a tenant-wide scan of bundle_items. Index-only;
-- SCHEMA_VERSION stays 8.
CREATE INDEX bundle_items_by_bundle
  ON bundle_items (tenant_id, bundle_id);

CREATE INDEX bundle_items_by_component
  ON bundle_items (tenant_id, component_product_id);

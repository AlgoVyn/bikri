-- 0019_sale_bundle_discount_total.sql
--
-- Denormalise the whole-bundle discount total on the bill so reports and CSV exports
-- do not have to re-read every sale line to show the discount.
ALTER TABLE sales ADD COLUMN bundle_discount_total INTEGER NOT NULL DEFAULT 0
  CHECK (bundle_discount_total >= 0);

UPDATE meta SET value = '6' WHERE key = 'schema_version';

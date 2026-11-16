-- 0018_bundle_discount.sql
--
-- A bundle can carry a manual discount on the whole-bundle price. The sale lines keep
-- the pre-discount bundle price in `bundle_price` and the per-bundle discount here, so
-- the discount can be checked against the staff limit and shown as "You saved".
ALTER TABLE sale_lines ADD COLUMN bundle_discount INTEGER
  CHECK (bundle_discount IS NULL OR bundle_discount >= 0);

UPDATE meta SET value = '5' WHERE key = 'schema_version';

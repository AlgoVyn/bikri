-- D-228: denormalise the sale's business date onto each sale line.
--
-- The till's Sales list, Home summary, 30-day best sellers and product detail all
-- needed lines for a business-date range, but sale_lines had no date column. They
-- therefore scanned every line the shop had ever written once a range crossed 100
-- bills. The column is derived from the parent sale; clients send it, and applyOps
-- fills it from the parent when an older client omits it.
--
-- sale_lines is append-only. The one-time backfill needs the UPDATE trigger out of
-- the way; it is recreated immediately below, before the migration ends.
DROP TRIGGER IF EXISTS sale_lines_append_only_update;

ALTER TABLE sale_lines ADD COLUMN business_date TEXT NOT NULL DEFAULT '';

UPDATE sale_lines
SET business_date = (
  SELECT s.business_date
  FROM sales s
  WHERE s.tenant_id = sale_lines.tenant_id AND s.id = sale_lines.sale_id
);

CREATE TRIGGER sale_lines_append_only_update
BEFORE UPDATE ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is append-only');
END;

-- The server never queries sale_lines by product or date (the till does, in Dexie);
-- drop the unused product index and keep D1 writes low. The local V7 index
-- [product_id+business_date] serves the product screen.
DROP INDEX IF EXISTS sale_lines_product;

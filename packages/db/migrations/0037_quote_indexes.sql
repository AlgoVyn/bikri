-- 0037_quote_indexes.sql
--
-- CORE-M1 from the 2026-11-27 whole-codebase review: drop six quotation indexes
-- that no server query uses. `quotation_lines_quote` is strictly redundant with
-- UNIQUE (tenant_id, quote_id, line_no); the other five are Dexie-only lookups.
-- Index-only; the wire schema and `SCHEMA_VERSION` stay at 10 (D-231).

DROP INDEX IF EXISTS quotation_lines_quote;
DROP INDEX IF EXISTS quotation_lines_product;
DROP INDEX IF EXISTS quotations_date;
DROP INDEX IF EXISTS quotations_validity;
DROP INDEX IF EXISTS quotations_customer;
DROP INDEX IF EXISTS quotations_sale;

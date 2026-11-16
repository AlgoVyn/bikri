-- D-231: drop indexes no production query in apps/api/src uses. D1 counts index
-- entries as rows written, and the 150-bill budget measured ~127 rows/bill with
-- these present; removing them recovers about a quarter of the daily write budget.
--
-- The client has its own Dexie indexes for the same columns; this only changes the
-- server schema. Keep every index that a query in routes/, sync/, platform/ or cron/
-- actually names (see apps/api/test/perf.test.ts HOT_QUERIES).
DROP INDEX change_log_row;
DROP INDEX change_log_at;
DROP INDEX applied_ops_device;
DROP INDEX sales_date;
DROP INDEX sales_customer;
DROP INDEX sales_device_seq;
DROP INDEX payments_date;
DROP INDEX payments_party;
DROP INDEX refunds_date;
DROP INDEX expenses_date;
DROP INDEX stock_movements_product;
DROP INDEX products_category;
DROP INDEX product_barcodes_product;
DROP INDEX customers_phone;
DROP INDEX promises_due;
DROP INDEX audit_log_entity;

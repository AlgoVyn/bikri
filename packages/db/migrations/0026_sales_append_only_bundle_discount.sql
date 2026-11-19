-- 0026_sales_append_only_bundle_discount.sql
--
-- 0019 added `sales.bundle_discount_total` with ALTER TABLE, but the append-only
-- trigger from 0010 lists its protected columns explicitly and was not rebuilt, so a
-- direct UPDATE of the new column slipped past the database-level guard. Recreate the
-- trigger with the full column list. Trigger-only change: the wire schema is unchanged.
DROP TRIGGER sales_append_only_update;

CREATE TRIGGER sales_append_only_update
BEFORE UPDATE OF tenant_id, id, invoice_no, invoice_seq, branch_id, device_id,
  staff_id, customer_id, business_date, created_at, line_count, items_qty_milli,
  gross_total, item_discount_total, subtotal, bill_discount_type,
  bill_discount_value, bill_discount, tax_rate_bp, tax, tax_inclusive, rounding,
  total, paid_total, udhaar_amount, cash_tendered, change_given, replaces_sale_id,
  bundle_discount_total, note
ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales is append-only');
END;

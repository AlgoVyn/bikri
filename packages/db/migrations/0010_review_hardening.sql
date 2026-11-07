-- Seventh-review hardening.
--
-- Bump the database marker with the Worker's SCHEMA_VERSION (apps/api/wrangler.jsonc).
UPDATE meta SET value = '2' WHERE key = 'schema_version';
--
-- 1. Snapshot the day-close informational totals so a reprint is immutable.
-- 2. Make the drawer period unique per device, including two concurrent first closes.
-- 3. Enforce append-only at the database level. The Worker already rejects updates and
--    deletes on ledger tables; these triggers also protect admin imports, cron paths and
--    future code. Deletes are allowed only while the shop is in maintenance (restore
--    purge) or deleting (tenant deletion), and only `sales.status` may change in place.

ALTER TABLE day_closes ADD COLUMN card_total INTEGER;
ALTER TABLE day_closes ADD COLUMN bank_total INTEGER;
ALTER TABLE day_closes ADD COLUMN udhaar_given INTEGER;
ALTER TABLE day_closes ADD COLUMN bills INTEGER;
ALTER TABLE day_closes ADD COLUMN refunds INTEGER;

DROP INDEX day_closes_device;
CREATE UNIQUE INDEX day_closes_device ON day_closes (tenant_id, device_id, period_end);
CREATE UNIQUE INDEX day_closes_device_start ON day_closes (tenant_id, device_id, period_start);

CREATE TRIGGER sales_append_only_update
BEFORE UPDATE OF tenant_id, id, invoice_no, invoice_seq, branch_id, device_id,
  staff_id, customer_id, business_date, created_at, line_count, items_qty_milli,
  gross_total, item_discount_total, subtotal, bill_discount_type,
  bill_discount_value, bill_discount, tax_rate_bp, tax, tax_inclusive, rounding,
  total, paid_total, udhaar_amount, cash_tendered, change_given, replaces_sale_id,
  note
ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales is append-only');
END;

CREATE TRIGGER sales_append_only_delete
BEFORE DELETE ON sales
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'sales is append-only');
END;

CREATE TRIGGER sale_lines_append_only_update
BEFORE UPDATE ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is append-only');
END;
CREATE TRIGGER sale_lines_append_only_delete
BEFORE DELETE ON sale_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is append-only');
END;

CREATE TRIGGER payments_append_only_update
BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments is append-only');
END;
CREATE TRIGGER payments_append_only_delete
BEFORE DELETE ON payments
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'payments is append-only');
END;

CREATE TRIGGER refunds_append_only_update
BEFORE UPDATE ON refunds
BEGIN
  SELECT RAISE(ABORT, 'refunds is append-only');
END;
CREATE TRIGGER refunds_append_only_delete
BEFORE DELETE ON refunds
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'refunds is append-only');
END;

CREATE TRIGGER refund_lines_append_only_update
BEFORE UPDATE ON refund_lines
BEGIN
  SELECT RAISE(ABORT, 'refund_lines is append-only');
END;
CREATE TRIGGER refund_lines_append_only_delete
BEFORE DELETE ON refund_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'refund_lines is append-only');
END;

CREATE TRIGGER sale_voids_append_only_update
BEFORE UPDATE ON sale_voids
BEGIN
  SELECT RAISE(ABORT, 'sale_voids is append-only');
END;
CREATE TRIGGER sale_voids_append_only_delete
BEFORE DELETE ON sale_voids
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'sale_voids is append-only');
END;

CREATE TRIGGER ledger_entries_append_only_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;
CREATE TRIGGER ledger_entries_append_only_delete
BEFORE DELETE ON ledger_entries
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER stock_movements_append_only_update
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;
CREATE TRIGGER stock_movements_append_only_delete
BEFORE DELETE ON stock_movements
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER purchases_append_only_update
BEFORE UPDATE ON purchases
BEGIN
  SELECT RAISE(ABORT, 'purchases is append-only');
END;
CREATE TRIGGER purchases_append_only_delete
BEFORE DELETE ON purchases
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'purchases is append-only');
END;

CREATE TRIGGER purchase_lines_append_only_update
BEFORE UPDATE ON purchase_lines
BEGIN
  SELECT RAISE(ABORT, 'purchase_lines is append-only');
END;
CREATE TRIGGER purchase_lines_append_only_delete
BEFORE DELETE ON purchase_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'purchase_lines is append-only');
END;

CREATE TRIGGER supplier_returns_append_only_update
BEFORE UPDATE ON supplier_returns
BEGIN
  SELECT RAISE(ABORT, 'supplier_returns is append-only');
END;
CREATE TRIGGER supplier_returns_append_only_delete
BEFORE DELETE ON supplier_returns
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'supplier_returns is append-only');
END;

CREATE TRIGGER supplier_return_lines_append_only_update
BEFORE UPDATE ON supplier_return_lines
BEGIN
  SELECT RAISE(ABORT, 'supplier_return_lines is append-only');
END;
CREATE TRIGGER supplier_return_lines_append_only_delete
BEFORE DELETE ON supplier_return_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'supplier_return_lines is append-only');
END;

CREATE TRIGGER expenses_append_only_update
BEFORE UPDATE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'expenses is append-only');
END;
CREATE TRIGGER expenses_append_only_delete
BEFORE DELETE ON expenses
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'expenses is append-only');
END;

CREATE TRIGGER cash_moves_append_only_update
BEFORE UPDATE ON cash_moves
BEGIN
  SELECT RAISE(ABORT, 'cash_moves is append-only');
END;
CREATE TRIGGER cash_moves_append_only_delete
BEFORE DELETE ON cash_moves
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'cash_moves is append-only');
END;

CREATE TRIGGER day_closes_append_only_update
BEFORE UPDATE ON day_closes
BEGIN
  SELECT RAISE(ABORT, 'day_closes is append-only');
END;
CREATE TRIGGER day_closes_append_only_delete
BEFORE DELETE ON day_closes
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'day_closes is append-only');
END;

CREATE TRIGGER audit_log_append_only_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_append_only_delete
BEFORE DELETE ON audit_log
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
